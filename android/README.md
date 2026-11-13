# Tickory voor Android

De Android-app van Tickory: de web-app van je eigen server in een eigen app, met **herinneringen als melding**, ook als
de app dicht is en ook zonder internet. Zonder Google Play, zonder Firebase, zonder trackers of statistieken.

De app haalt je taken en herinneringen op bij je server en zet ze als alarmen op het toestel zelf. Daardoor gaat een
herinnering ook af als de server even niet bereikbaar is. Met de **widgets** (vanaf de volgende versie) zie je je taken op het
startscherm en vink je ze daar af; zie [Widgets](#widgets).

## Installeren op een telefoon

1. Zet het APK-bestand (`tickory-<versie>.apk`) op de telefoon, bijvoorbeeld door het te downloaden van de releasepagina.
2. Open het bestand. Android vraagt de eerste keer of de app waarmee je het opent (je browser of bestandsbeheer)
   **onbekende apps mag installeren**: sta dat toe en ga terug. Dit hoeft maar één keer.
3. Open Tickory, vul het **adres van je server** in (bijvoorbeeld `https://taken.voorbeeld.nl` of
   `http://192.168.1.10:8787`) en log in.
4. Sta **meldingen** toe als de app daarom vraagt.

Bijwerken: installeer de nieuwe APK over de oude heen; je gegevens blijven staan. Dat kan alleen als beide met dezelfde
sleutel zijn ondertekend (zie [Ondertekenen](#ondertekenen)). Android 8 of nieuwer is nodig.

## Welke toestemmingen, en waarom

| Toestemming | Waarvoor |
|---|---|
| Internet | De server bereiken. |
| Meldingen (Android 13+, je wordt erom gevraagd) | De herinneringen tonen. |
| Starten na opstarten van het toestel | Android wist alarmen bij uitschakelen; de app zet ze na het opstarten opnieuw. |
| Exacte alarmen | Een herinnering op de minuut laten afgaan, ook in de slaapstand. Op Android 13+ staat dit vast aan; op Android 12 kun je het uitzetten. |
| Apparaten in de buurt (alleen Android 17+, je wordt erom gevraagd) | Android 17 laat een app pas bij adressen op je thuisnetwerk na deze toestemming. De app vraagt hem alleen als je server thuis staat (`192.168.…`, `nas.local`), en gebruikt hem alleen om die server te bereiken. |
| Netwerkstatus en wakker blijven | Voor het verversen op de achtergrond: alleen met verbinding, en het werk afmaken voordat het toestel weer slaapt. Komt mee met WorkManager. |

De widgets vragen **geen extra toestemming**: ze doen zelf geen netwerkverkeer; het afvinken en verversen loopt via dezelfde
WorkManager-taak als de herinneringen.

De app vraagt geen toegang tot locatie, contacten, bestanden, camera of microfoon.

## Komen de meldingen niet?

- **Meldingen staan uit.** Instellingen › Apps › Tickory › Meldingen: zet ze aan, ook het kanaal *Herinneringen*.
- **Batterijbesparing.** Instellingen › Apps › Tickory › Batterij: kies *Onbeperkt*. Sommige merken (Xiaomi, Huawei,
  OnePlus, Samsung) sluiten apps op de achtergrond extra streng af; zoek dan ook naar *Automatisch starten* of
  *Slapende apps* en zonder Tickory daarvan uit.
- **Exacte alarmen (Android 12).** Instellingen › Apps › Speciale toegang › Wekkers en herinneringen: zet Tickory aan.
  Staat het uit, dan komt de herinnering wel, maar soms enkele minuten later.
- **De app is geforceerd gestopt.** Na *Gedwongen stoppen* geeft Android niets meer door tot je de app weer opent.
- **Niet storen** of een stil profiel houdt het geluid tegen; de melding staat er dan wel.
- **Net ingelogd of een herinnering net gemaakt?** De app ververst direct, daarna elk kwartier en telkens als je hem opent.

## Wat de app wel en niet deelt

- De app praat alleen met de server die jij invult. Er zit geen dienst van Google of een ander bedrijf tussen.
- De ingebouwde browser (Android System WebView) stuurt geen statistieken naar Google en gebruikt geen *Safe Browsing*.
- De aanmelding die de app zelf op de achtergrond gebruikt, staat versleuteld op het toestel (sleutel in de Android
  Keystore). De web-app in de WebView bewaart zoals elke browser haar eigen kopie van het token in `localStorage`, in de
  privé-opslag van de app en niet versleuteld; wie het toestel rootet of de gegevens van de app kan lezen, kan die dus ook
  lezen. Niets van de app gaat mee in back-ups naar de cloud of bij het overzetten naar een ander toestel.
- `http://` is alleen toegestaan voor een adres op het eigen netwerk (een privé-IP-adres, een naam als `nas.local` of een naam
  zonder punt) en voor het toestel zelf; daar is de verbinding niet versleuteld maar leest niemand van buiten mee. De app
  waarschuwt als je zo'n adres invult. Een `http://`-adres naar een server op internet weigert de app, ook als dat in een
  oudere versie is ingesteld (dan toont hij het foutscherm met "Serveradres wijzigen"); gebruik daar https.

## Talen

Nederlands is de standaardtaal (`app/src/main/res/values/strings.xml`), Engels staat in `values-en/strings.xml`. De app
volgt de taal van het toestel; elke andere taal dan Engels krijgt Nederlands. De build maakt van de Nederlandse teksten
ook een map `values-nl`, anders kiest Android bij de volgorde "Nederlands, daarna Engels" voor Engels.
Een tekst toevoegen: in beide bestanden; `./gradlew lintDebug` meldt het als er een ontbreekt.

## Bouwen

Nodig: JDK 21 (17 of nieuwer werkt) en de Android SDK met `platforms;android-37.0` en `build-tools;36.0.0`. Zet
`ANDROID_HOME` naar de map van de SDK, of maak `android/local.properties` met `sdk.dir=…`. Gradle komt vanzelf mee.

```sh
cd android
./gradlew testDebugUnitTest   # tests
./gradlew lintDebug           # controle op veelgemaakte fouten
./gradlew assembleDebug       # app/build/outputs/apk/debug/tickory-debug.apk
```

Op Windows: `gradlew.bat` in plaats van `./gradlew`. De versie van de app komt uit `../package.json`
(`0.2.0` wordt versienaam `0.2.0` en versiecode `200`: major × 10000 + minor × 100 + patch).

Gekozen versies, tegen de officiële tabellen gecontroleerd (staan in `gradle/libs.versions.toml`):

| Onderdeel | Versie | Reden |
|---|---|---|
| Gradle | 9.6.1 | De Android Gradle Plugin 9.3 vraagt 9.5.0 of hoger; Kotlin 2.4.21 is getest tot en met 9.7.0. |
| Android Gradle Plugin | 9.3.3 | Laatste reeks waarvoor Kotlin 2.4.21 getest is (t/m 9.3.1). Nieuwer bestaat (9.5.1). |
| Kotlin | 2.4.21 | Laatste stabiele versie. De plugin compileert Kotlin zelf; deze regel kiest alleen de versie. |
| compileSdk / targetSdk | 37 (Android 17) | Hoogste niveau dat de plugin ondersteunt. |
| minSdk | 26 (Android 8) | Meldingskanalen en `java.time` zijn er dan altijd. |

### Tests

De tests draaien op de pc, zonder telefoon. Een deel test de rekenregels (wanneer gaat een herinnering af, ook rond
zomer- en wintertijd); een deel bootst Android na met Robolectric (alarmen, meldingen, de knoppen, opstarten, de
schermen en de brug). Robolectric haalt de eerste keer een bestand van ongeveer 150 MB op.

De widgets hebben eigen tests: welke taken zichtbaar zijn en in welke volgorde (ook rond de tijdzone, middernacht en de zomer-
en wintertijd), de bewaarde gegevens per gebruiker (afmelden, een ander account, herstart), de wachtrij voor afvinken (dubbel
tikken, opnieuw proberen met hetzelfde uuid, weigering, 401, een oudere server), de hele verversing tegen een testserver, het
tekenen van de widgets, het configuratiescherm, het manifest (wat exporteerbaar is) en de leesbaarheid van de kleuren. Die
tests staan in `core/Widget*Test.kt` en `widget/Widget*Test.kt`. Aan de kant van de server en de web-app staan ze in
`server/sync.test.ts` (`if_due`) en `client/core/widgets.test.js`.

Eén test praat met een echte server en draait alleen als je het adres opgeeft:

```sh
# in de map van de repo: een wegwerpserver met een eigen, lege database
DB_PATH=/tmp/tickory-test/todo.db PORT=8795 TODO_ADMIN_USER=test TODO_ADMIN_PASSWORD=test-wachtwoord-1 node server/main.ts
# in android/
TICKORY_TEST_SERVER=http://127.0.0.1:8795 ./gradlew testDebugUnitTest --tests "*RealServerTest*"
```

### Ondertekenen

Android werkt een app alleen bij als de nieuwe APK met **dezelfde sleutel** is ondertekend als de oude. Wie de sleutel
kwijtraakt, kan geen update meer uitbrengen: iedereen moet de app dan verwijderen en opnieuw installeren. Bewaar het
sleutelbestand en de wachtwoorden dus goed, en buiten de repo.

- `assembleDebug` tekent met een wegwerpsleutel van de computer waarop je bouwt. Goed om te proberen, niet om te verspreiden:
  een debug-APK van een andere computer (of van GitHub Actions) kan hem niet bijwerken.
- `assembleRelease` tekent met je eigen sleutel als deze vier omgevingsvariabelen zijn gezet:
  `ANDROID_KEYSTORE_FILE` (pad naar het sleutelbestand), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` en
  `ANDROID_KEY_PASSWORD`. Het resultaat is `app/build/outputs/apk/release/tickory-release.apk`.
  Zonder die variabelen komt er `tickory-release-unsigned.apk`; die is zo niet te installeren.
- GitHub Actions (`.github/workflows/android.yml`) bouwt bij een tag `v…` en hangt `tickory-<versie>.apk` aan de
  release. Zet daarvoor de secrets `ANDROID_KEYSTORE_BASE64` (het sleutelbestand als base64), `ANDROID_KEYSTORE_PASSWORD`,
  `ANDROID_KEY_ALIAS` en `ANDROID_KEY_PASSWORD`. **Zonder (alle vier) die secrets mislukt de bouw bij een tag**: er komt nooit
  een debug-APK in een openbare Release. Bij handmatig starten (Run workflow) zonder secrets komt er wel een debug-APK bij de
  run, alleen om te proberen. De bouw leest alleen (`contents: read`); een aparte job hangt de APK aan de release.

## Pictogram vervangen

Het pictogram van de app komt uit dat van de web-app. Na een nieuw logo:

1. Zorg dat `client/icon-maskable-512.png` het nieuwe logo is: vierkant, het hele vlak gevuld (geen doorzichtige
   hoeken) en het beeld binnen de middelste 80%. Op dit moment schrijft `node scripts/make-icons.js` dat bestand.
2. `node android/tools/make-launcher-icons.mjs` maakt daaruit de voorgrond in vijf scherpten
   (`res/mipmap-*/ic_launcher_foreground.png`) en de achtergrondkleur (`res/values/ic_launcher_background.xml`).
3. Twee kleine tekeningen bevatten alleen de vorm van het logo en zijn met de hand gemaakt van het pad in
   `client/icon.svg`. Vervang daarin `android:pathData` (en pas zo nodig de schaal aan):
   - `res/drawable/ic_launcher_monochrome.xml`: het eenkleurige pictogram voor "pictogrammen met thema" (Android 13+);
   - `res/drawable/ic_stat_reminder.xml`: het pictogram in de statusbalk bij een melding (nu een vinkje).

## Hoe het in elkaar zit

- `core/`: zuivere Kotlin zonder Android: het adres controleren, JSON lezen, de planner (`Planner.kt`), de regels rond
  tonen en uitstellen (`ReminderState.kt`) en de verzoeken aan de server (`ApiClient.kt`).
- `reminders/`: alarmen (`AlarmManager`), meldingen en de ontvangers voor alarm, knoppen en opstarten.
- `sync/`: de aanmelding en het verversen met WorkManager (elk kwartier, alleen met verbinding).
- `store/`: wat de app op het toestel bewaart: het serveradres, het versleutelde token, het plan van de herinneringen en (`WidgetStore`) de gegevens en de wachtrij van de widgets.
- `widget/`: de widgets: de ontvangers (`Providers.kt`), het tekenen (`ListWidgets`), de regels van de lijst (`WidgetListService`), het scherm om te kiezen wat een widget toont (`WidgetConfigActivity`) en wat een tik doet (`WidgetActions`, `WidgetActionActivity`). De regels van wat er te zien is, staan zonder Android in `core/Widget*.kt`.
- `MainActivity` (de WebView), `SetupActivity` (het serveradres) en `WebBridge`.

De web-app praat met de app via `window.TickoryAndroid`. De brug doet alleen iets als de geladen pagina van de
ingestelde server komt.

| Aanroep | Betekenis |
|---|---|
| `setSession(token)` | Het sessietoken na inloggen; `""` bij afmelden (wist token, alarmen en meldingen). |
| `remindersChanged()` | Taken of herinneringen zijn gewijzigd: meteen verversen, en een halve minuut later nog eens. |
| `widgetsChanged()` | Iets dat in de widgets staat (titel, datum, prioriteit, plek, volgorde, projectnaam) is gewijzigd: hetzelfde verversen; daarna tekenen de widgets zich opnieuw. |
| `notificationStatus()` | JSON-tekst: `{"notifications":bool,"exactAlarms":bool,"batteryOptimized":bool,"appVersion":"…"}`. |
| `requestNotificationPermission()` | Vraagt de toestemming voor meldingen; opent zo nodig de instellingen. |
| `openNotificationSettings()`, `openBatterySettings()` | Openen de instellingen van Android voor deze app. |
| `changeServer()` | Terug naar het instelscherm, na bevestiging. |

Na een toestemmingsvraag of terugkeer uit de instellingen stuurt de app het voorval `tickory-android-status` op
`window`; de web-app kan dan `notificationStatus()` opnieuw opvragen. Een melding en een tik op een taak in een
widget openen de web-app op `<server>/#task=<id>`; de knop "+" van een widget op `<server>/#add` (`#add=today` met vandaag als
datum, `#add=<project-id>` in dat project). Alleen veilige tekens komen in zo'n adres (`core/DeepLink.kt`).

## Widgets

Vier widgets, zonder extra bibliotheken (`AppWidgetProvider`, `RemoteViews` en een `RemoteViewsService`; Glance zou Compose en
meer afhankelijkheden meebrengen voor niets dat we nodig hebben):

| Widget | Wat |
|---|---|
| Vandaag | Achterstallige taken en wat vandaag moet, afvinken met een tik op de cirkel (kleur van de prioriteit), tik op de titel opent de taak, kop met datum en aantal, knop "+" voor Taak toevoegen, een lege staat |
| Project of lijst | Bij het plaatsen kies je (`WidgetConfigActivity`) de Inbox, een project, Vandaag of Binnenkort; opnieuw kiezen kan vanaf Android 9. De keuze is een tekst per widget (`WidgetSource`: `today`, `upcoming`, `inbox`, `project:<id>`, en gereserveerd `filter:<id>`); filters komen erbij door een bron en een regel in `WidgetChoices` toe te voegen |
| Binnenkort | Vanaf morgen veertien dagen, per dag met een kop |
| Taak toevoegen | Een knop (1×1 en breder, het woord verdwijnt als hij smal is) die de app opent op `#add`, voor de Inbox |

Formaat: minstens 2×2 voor de lijsten (verkleinen tot ongeveer 110×110 dp en vergroten tot 450×600 dp), de knop vanaf 1×1. Drie
klassen (`WidgetSize`: klein, middel, groot) bepalen de opmaak: klein zet het aantal naast de titel en laat de tweede regel
weg, groot gebruikt iets grotere letters. Licht en donker volgen het systeem (`values` en `values-night`); op Android 12 en
nieuwer volgen achtergrond, tekst en accent het thema van de gebruiker (`values-v31` en `values-night-v31`, de kleuren
`system_neutral1_*` en `system_accent1_*`) en de hoeken die van het systeem; de prioriteitskleuren blijven vast. Elke regel is
minstens 48 dp hoog en de cirkel is 48 dp breed. De cirkel, de titel en de kop hebben een beschrijving voor TalkBack. De teksten
staan in `strings.xml` in beide talen (`lintDebug` controleert dat).

**Gegevens.** De widgets lezen alleen wat op het toestel staat: `widget-cache.json` (open taken, projecten, secties, labels en
het gebruikers-id) en `widget-queue.json` (afgevinkt, nog niet bevestigd) in `files/widgets/`, beide atomair geschreven. De cache
komt uit hetzelfde verzoek als de herinneringen (`SyncWorker`; nu met `projects`, `sections` en `labels`) en wordt ververst bij
inloggen, bij openen van de app, na `remindersChanged()`/`widgetsChanged()`, na een tik in een widget en elk kwartier (de bestaande
WorkManager-taak met netwerkvoorwaarde); `updatePeriodMillis` (30 minuten) en één onnauwkeurig alarm na middernacht tekenen de
widgets opnieuw uit de cache, zonder netwerk. Zonder aanmelding staat er "Log in in de app", bij een verlopen sessie "Log opnieuw
in in de app".

**Wie.** Afmelden en een ander serveradres wissen cache en wachtrij. Een ander token (nieuwe aanmelding) maakt de cache
"ongecontroleerd": de widgets tonen niets en er wordt niets verstuurd, tot de eerstvolgende verversing laat zien van wie de
gegevens zijn; een ander gebruikers-id vervangt alles en gooit de wachtrij weg, hetzelfde id laat de wachtrij staan. In gedeelde
projecten staat alleen wat de server stuurt; is de gebruiker geen lid meer, dan verdwijnt het project bij de volgende verversing.

**Afvinken** (`WidgetActions.complete`, `WidgetSync.flush`):

1. De tik komt als intentie bij `WidgetActionActivity` (geen weergave, sluit meteen). Die zet `{taak, uuid, if_due, gebruiker, tijd}`
   in de wachtrij. Staat de taak er al in (dubbel tikken), dan gebeurt er niets.
2. De taak, en bij een gewone taak ook zijn subtaken, is meteen weg uit alle widgets: wat in de wachtrij staat wordt verborgen.
   Er is niets aan de bewaarde gegevens verzonnen. Bij een **terugkerende taak** kent alleen de server de volgende datum; de taak
   blijft weg tot de verversing na het versturen hem terugbrengt met die datum (de veilige weg, boven zelf doorrekenen).
   `ReminderEngine.onCompletedLocally` laat de herinneringen, het uitstel en de meldingen van de taak meteen vervallen.
3. `SyncWorker` stuurt de wachtrij vóór het ophalen als `task_complete` (hooguit 50 per verzoek). De uitkomst per commando:
   `ok` of welke weigering ook (taak weg, geen lid meer, ...) haalt de regel uit de wachtrij; een netwerkfout of 5xx laat hem
   staan (opnieuw proberen met hetzelfde uuid, met oplopende pauzes; daarna het kwartierwerk); `401` laat hem staan en markeert de
   sessie als verlopen; wat ouder is dan drie dagen vervalt. Daarna volgt altijd een verversing, zodat de widget laat zien hoe het
   er echt voor staat.
4. **Geen dubbele uitvoering.** Het uuid is per actie en blijft gelijk bij opnieuw proberen; de server voert een uuid één keer uit.
   Bij een terugkerende taak gaat `if_due` (de datum die je zag) mee: heeft de taak intussen een andere datum, omdat de web-app of
   een ander apparaat hem al afvinkte, dan doet de server niets. De web-app stuurt `if_due` zelf ook mee, en de reducer doet
   lokaal hetzelfde. Een oudere server die `if_due` niet kent (`UNKNOWN_ARG`) krijgt dezelfde actie nog eens zonder, met een nieuw uuid.

**Veiligheid.** Het token blijft in de Keystore; de widgets lezen het niet en geen enkele widget doet zelf netwerkverkeer.
Providers, de lijstservice (`BIND_REMOTEVIEWS`), de tikafhandeling en het middernachtalarm zijn `exported="false"`; alleen
`WidgetConfigActivity` is exporteerbaar (Android moet het starten) en controleert dat het widget-id van een "Project of lijst"-widget
is. Alle intenties zijn expliciet en `FLAG_IMMUTABLE`, op één na: het sjabloon van de lijst (`FLAG_MUTABLE`) moet per regel
worden aangevuld met de taak waarop getikt is (`setOnClickFillInIntent`), anders weet Android niet welke regel het was. Het wijst
naar `WidgetActionActivity` (niet exporteerbaar) en elk id wordt daar gecontroleerd (`Ids.isSafeId`). Er komt geen taakinhoud in
het logboek. Gegevens op het toestel zijn niet versleuteld (net als het plan van de herinneringen); ze staan in de privé-opslag van
de app en niet in back-ups.

**Wat alleen op een echt toestel te controleren is.** Alles hierboven is getest op een nagebootste Android (Robolectric), maar de
emulator kon op de ontwikkelmachine niet starten en er is niets op een telefoon geprobeerd:

- hoe de widgets er per launcher uitzien (Pixel Launcher, Samsung One UI, Xiaomi, ...): hoeken, marges, lettergrootte, de overgang
  tussen klein, middel en groot, en of het formaat aanpassen soepel gaat;
- of een tik op de cirkel zonder flits of animatie van de launcher verloopt (het scherm daarachter heeft geen weergave en sluit meteen);
- de kleuren van Material You bij een ander thema of achtergrond, en hoe donker/licht omschakelt;
- scrollen door een lange lijst en het gedrag van de lijst na het verversen;
- gedrag onder stroombesparing: komt het verversen elk kwartier, en komt een afgevinkte taak aan na een nacht zonder verbinding;
- TalkBack: wat er daadwerkelijk wordt voorgelezen;
- of Android het middernachtalarm op tijd uitvoert (het is onnauwkeurig en mag worden uitgesteld).

**Korte testlijst voor op een toestel**

1. Installeer de APK, log in, plaats **Vandaag**: staan de taken van vandaag en wat te laat is erin, met het goede aantal?
2. Tik op de cirkel van een taak: verdwijnt hij meteen, en staat hij ook afgevinkt in de app en op een andere browser?
3. Zet vliegtuigmodus aan, vink twee taken af in de widget, zet de modus uit: zijn ze binnen een paar minuten afgevinkt op de server?
4. Vink een terugkerende taak af: komt hij terug met de volgende datum (niet twee keer doorgeschoven, ook niet als je dezelfde taak
   in de app aftikt)?
5. Tik op een titel: opent de app bij die taak? Tik op "+": opent het venster Taak toevoegen (in Vandaag met datum vandaag)?
6. Plaats **Project of lijst** voor een project en voor de Inbox; kies opnieuw via lang indrukken; maak het groot en klein.
7. Wissel donker/licht en (Android 12+) het kleurenthema van je achtergrond: volgt de widget?
8. Wijzig een taak in de app: staat de wijziging binnen een paar seconden in de widget? Verwijder de taak op een andere browser:
   verdwijnt hij uit de widget na een paar minuten?
9. Log uit in de app: staat er "Log in in de app" en is er geen taak meer te zien? Log in met een ander account: zie je niets van
   het vorige?
10. Laat een widget een dag op het scherm staan zonder de app te openen: staat "Vandaag" na middernacht goed?
11. Zet TalkBack aan: wordt "Voltooien: <taak>" voorgelezen bij de cirkel?

## Bekende beperkingen

- **Zonder verbinding openen werkt alleen met https.** De web-app bewaart zichzelf met een service worker, en browsers
  staan die alleen toe op https. Met een `http://`-adres opent de app buitenshuis dus niet; de herinneringen gaan wel af.
- **Eigen certificaten.** De app vertrouwt alleen certificaten die Android zelf vertrouwt (zoals Let's Encrypt), geen
  zelfgemaakte of zelf toegevoegde.
- **Een inlogpagina vóór de server** (Authelia, Cloudflare Access en dergelijke) werkt niet: de app opent alleen het
  ingestelde adres en kan `/health` en `/api/` dan niet bereiken.
- **Herinneringen van meer dan een uur geleden** (toestel stond uit) worden niet alsnog getoond.
- De app plant hooguit 200 herinneringen, tot 30 dagen vooruit; bij elke verversing schuift dat venster mee.
