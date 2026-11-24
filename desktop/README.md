# Tickory voor Windows (desktop-app)

Een Electron-schil om de web-app van je eigen Tickory-server, met wat je van een desktop-app voor taken verwacht: het systeemvak-menu, globale
sneltoetsen (Windows: `Control+Space` voor Taak toevoegen, `Super+Alt+S` om de app te tonen), een los venster Taak toevoegen, de stip op de
taakbalk (`setOverlayIcon`) als er taken voor vandaag zijn, meldingen met knoppen, het hoofdmenu (zoom, zwevend op voorgrond, terug/verder),
"In systeemvak blijven draaien", opstarten met Windows, "Applicatiegegevens verwijderen" en updates via `electron-updater`. De desktop-app van
Todoist was het voorbeeld voor wat de app kan; de code, beelden en teksten zijn van Tickory zelf.

## Hoe het in elkaar zit

| Bestand | Wat |
|---|---|
| `main.mjs` | Het hoofdproces: vensters, systeemvak, menu's, sneltoetsen, herinneringen, updates |
| `preload.cjs` | De brug `window.TickoryDesktop` voor de web-app (sessie, herinneringen gewijzigd, badge, taal, venster Taak toevoegen) |
| `lib/server.mjs` | Het serveradres: https, of http alleen in je eigen netwerk; alleen die origin mag in het venster |
| `lib/settings.mjs` | De instellingen van de app (`settings.json` in de gebruikersmap) |
| `lib/reminderPlan.mjs` | Welke herinneringen afgaan (met `shared/reminders.js`, dezelfde regels als de server), de herinneringen op notities (`shared/notes.js`), het ochtendoverzicht en de avondreview, en "vandaag" voor het systeemvak |
| `lib/syncCache.mjs` | Wat de app van je account bijhoudt: eerst alles, daarna delta's met `sync_token` |
| `lib/inboxPlan.mjs` | Meldingen bij samenwerken: welke nieuw zijn, welke in beeld komen en welke weg moeten (zoals `Inbox.kt` in de Android-app) |
| `lib/menuModel.mjs` | Het systeemvak-menu en het hoofdmenu als gegevens |
| `lib/toast.mjs` | De melding van Windows (ToastGeneric met knoppen) en de adressen `tickory://open?task=|note=|notification=|view=…` en `tickory://complete|snooze?task=…` |
| `lib/i18n.mjs` | De teksten van de app zelf, Nederlands en Engels |
| `lib/appearance.mjs` | Het thema (zoals het apparaat, licht, donker) en de accentkleur, met de lijst uit `client/core/theme.js` |
| `pages/` | De eigen schermen: het serveradres kiezen en de instellingen |

In de web-client: `client/core/desktop.js` (de brug) en `installDesktopQuickAdd` in `client/ui/app.js` (het losse venster Taak toevoegen,
`?desktop=quickadd`: alleen het venster, op een doorzichtig venster zoals bij Todoist).

**Meldingen.** Electron kent geen web-push. De app krijgt het sessietoken van de web-app (bewaard met `safeStorage`, gekoppeld aan je
Windows-account) en haalt taken, herinneringen, instellingen, meldingen bij samenwerken, notities, projecten en opmerkingen op: eerst alles,
daarna alleen wat er veranderde (`lib/syncCache.mjs`). Hij luistert naar het seintje van de server (`/api/v1/events`, met
`client/core/events.js`) en werkt bij elke wijziging bij; elke vijf minuten en na de slaapstand ook. Hij plant de herinneringen van de
komende 26 uur als timers: bij taken, op notities, en het ochtendoverzicht en de avondreview. Een getoonde herinnering wordt onthouden
(niet dubbel). Nieuwe meldingen bij samenwerken komen in beeld zoals in de Android-app (`lib/inboxPlan.mjs`). De knoppen van een melding
gaan via het protocol `tickory://`, zodat ze ook werken als de melding uit het Actiecentrum komt; Voltooien stuurt `task_complete` met een
eigen uuid, Uitstellen plant de herinnering opnieuw op deze pc (zo lang als in Instellingen › Herinneringen gekozen). In de web-app staat
onder Instellingen › Herinneringen een testmelding (`desktop:test-notification`) en een knop naar de meldingen van Windows.

Rooktest van de meldingen (buiten beeld, meldingen naar `notifications.json`): `TICKORY_DESKTOP_NOTIFY=1` opent Instellingen ›
Herinneringen, stuurt de testmelding en legt in `notify.json` vast wat de app ophaalde en plande.

**Thema.** Zoals in de Android-app is het thema te kiezen: in de web-app (Instellingen › Weergave) en in de eigen Instellingen van de
app. De web-app geeft haar keuze over de brug door; de app zet dan `nativeTheme.themeSource` (titelbalk,
menu's, `prefers-color-scheme` in alle vensters), de achtergrond en `setAccentColor` van de vensters, en geeft de keuze aan de andere
vensters (Taak toevoegen). De keuze staat ook in `settings.json`; bij het opstarten wint die (gekozen terwijl de web-app dicht was),
tenzij er nog niets stond (dan neemt de app de keuze van de web-app over). Rooktest: `TICKORY_DESKTOP_APPEARANCE=dark:teal` (eigen
Instellingen), `web:light:blue` (via het scherm Weergave) of `check`, met `appearance.json` als uitkomst.

**Veiligheid.** De pagina's van de server draaien met `contextIsolation` en `sandbox`, zonder Node. Andere adressen dan je server openen in
de browser. De brug neemt alleen het token, een getal en vaste waarden aan; de app stuurt de web-app alleen een fragment (`#view=…`, `#task=…`).

## Ontwikkelen en testen

```bash
cd desktop
npm install          # electron, electron-builder, electron-updater
npm test             # de onderdelen zonder Electron (node --test)
npm start            # de app (vraagt bij de eerste start het serveradres)
npm run dist         # de installer in dist/ (Tickory-Setup-<versie>.exe, latest.yml)
```

Een rooktest zonder dat er iets op het scherm verschijnt (alleen bij het ontwikkelen; de installer kent dit niet): de vensters staan buiten
beeld, er worden geen sneltoetsen, geen systeemvak-icoon en geen `tickory://`-koppeling geregistreerd, en meldingen gaan naar een bestand.

```bash
TICKORY_DESKTOP_DATA=<map voor instellingen> TICKORY_DESKTOP_SHOT=<map voor afdrukken> \
TICKORY_DESKTOP_TOKEN=<sessietoken> TICKORY_DESKTOP_ACTION='tickory://complete?task=<id>' npx electron .
```

Dat geeft `main.png`, `quickadd.png`, `tray.json` (het systeemvak-menu) en `notifications.json`.

## Uitbrengen

De workflow `.github/workflows/desktop.yml` bouwt bij elke versie-tag op Windows de installer (versie uit `package.json` in de hoofdmap) en
hangt `Tickory-Setup-<versie>.exe`, de blockmap en `latest.yml` aan de GitHub Release; daar haalt de app zijn updates. De installer is niet
ondertekend met een certificaat; SmartScreen kan bij de eerste keer waarschuwen.

## Bekende beperkingen

- Getest met een rooktest tegen een echte server (venster, venster Taak toevoegen, systeemvak-menu, een herinnering, Voltooien en Uitstellen),
  niet met de hand op meerdere pc's; de installer zelf is gebouwd maar niet geïnstalleerd tijdens het testen.
- Geen spraak (Electron heeft geen spraakdienst), geen herinneringen als de app helemaal dicht is, alleen Windows.
