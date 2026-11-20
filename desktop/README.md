# Tickory voor Windows (desktop-app)

Een Electron-schil om de web-app van je eigen Tickory-server, gebouwd naar de desktop-app van Todoist (die is hetzelfde: een schil om
todoist.com). De opbouw en het gedrag zijn uitgelezen uit de installer van Todoist (`Todoist-win32-9.36.2-latest.exe`: NSIS met een 7z-archief,
daarin `resources/app.asar` met `webpack/electron/electron.js`, de preload en de teksten). Overgenomen: het systeemvak-menu, de globale
sneltoetsen (Windows: `Control+Space` voor Taak toevoegen, `Super+Alt+S` om de app te tonen), een los venster Taak toevoegen, de stip op de
taakbalk (`setOverlayIcon`) als er taken voor vandaag zijn, meldingen met knoppen, het hoofdmenu (zoom, zwevend op voorgrond, terug/verder),
"In systeemvak blijven draaien", opstarten met Windows, "Applicatiegegevens verwijderen" en updates via `electron-updater`. Niets van Todoist
zelf (code, beelden, teksten van betekenis) zit erin.

## Hoe het in elkaar zit

| Bestand | Wat |
|---|---|
| `main.mjs` | Het hoofdproces: vensters, systeemvak, menu's, sneltoetsen, herinneringen, updates |
| `preload.cjs` | De brug `window.TickoryDesktop` voor de web-app (sessie, herinneringen gewijzigd, badge, taal, venster Taak toevoegen) |
| `lib/server.mjs` | Het serveradres: https, of http alleen in je eigen netwerk; alleen die origin mag in het venster |
| `lib/settings.mjs` | De instellingen van de app (`settings.json` in de gebruikersmap) |
| `lib/reminderPlan.mjs` | Welke herinneringen afgaan (met `shared/reminders.js`, dezelfde regels als de server) en "vandaag" voor het systeemvak |
| `lib/menuModel.mjs` | Het systeemvak-menu en het hoofdmenu als gegevens |
| `lib/toast.mjs` | De melding van Windows (ToastGeneric met knoppen) en de adressen `tickory://open|complete|snooze?task=…` |
| `lib/i18n.mjs` | De teksten van de app zelf, Nederlands en Engels |
| `pages/` | De eigen schermen: het serveradres kiezen en de instellingen |

In de web-client: `client/core/desktop.js` (de brug) en `installDesktopQuickAdd` in `client/ui/app.js` (het losse venster Taak toevoegen,
`?desktop=quickadd`: alleen het venster, op een doorzichtig venster zoals bij Todoist).

**Herinneringen.** Electron kent geen web-push. De app krijgt het sessietoken van de web-app (bewaard met `safeStorage`, gekoppeld aan je
Windows-account), haalt elke vijf minuten (en meteen na een wijziging of na de slaapstand) taken, herinneringen en instellingen op, en plant
de herinneringen van de komende 26 uur als timers. Een getoonde herinnering wordt onthouden (niet dubbel). De knoppen van een melding gaan via
het protocol `tickory://`, zodat ze ook werken als de melding uit het Actiecentrum komt; Voltooien stuurt `task_complete`, Uitstellen een
`reminder_add` (zo lang als in Instellingen › Algemeen gekozen), elk met een eigen uuid.

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
