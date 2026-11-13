# Tickory voor Android

De Android-app van Tickory: de web-app van je eigen server in een eigen app, met **herinneringen als melding**, ook als
de app dicht is en ook zonder internet. Zonder Google Play, zonder Firebase, zonder trackers of statistieken.

De app haalt je taken en herinneringen op bij je server en zet ze als alarmen op het toestel zelf. Daardoor gaat een
herinnering ook af als de server even niet bereikbaar is.

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
- `store/`: wat de app op het toestel bewaart: het serveradres, het versleutelde token en het plan van de herinneringen.
- `MainActivity` (de WebView), `SetupActivity` (het serveradres) en `WebBridge`.

De web-app praat met de app via `window.TickoryAndroid`. De brug doet alleen iets als de geladen pagina van de
ingestelde server komt.

| Aanroep | Betekenis |
|---|---|
| `setSession(token)` | Het sessietoken na inloggen; `""` bij afmelden (wist token, alarmen en meldingen). |
| `remindersChanged()` | Taken of herinneringen zijn gewijzigd: meteen verversen, en een halve minuut later nog eens. |
| `notificationStatus()` | JSON-tekst: `{"notifications":bool,"exactAlarms":bool,"batteryOptimized":bool,"appVersion":"…"}`. |
| `requestNotificationPermission()` | Vraagt de toestemming voor meldingen; opent zo nodig de instellingen. |
| `openNotificationSettings()`, `openBatterySettings()` | Openen de instellingen van Android voor deze app. |
| `changeServer()` | Terug naar het instelscherm, na bevestiging. |

Na een toestemmingsvraag of terugkeer uit de instellingen stuurt de app het voorval `tickory-android-status` op
`window`; de web-app kan dan `notificationStatus()` opnieuw opvragen. Een melding opent de web-app op
`<server>/#task=<id>`.

## Bekende beperkingen

- **Zonder verbinding openen werkt alleen met https.** De web-app bewaart zichzelf met een service worker, en browsers
  staan die alleen toe op https. Met een `http://`-adres opent de app buitenshuis dus niet; de herinneringen gaan wel af.
- **Eigen certificaten.** De app vertrouwt alleen certificaten die Android zelf vertrouwt (zoals Let's Encrypt), geen
  zelfgemaakte of zelf toegevoegde.
- **Een inlogpagina vóór de server** (Authelia, Cloudflare Access en dergelijke) werkt niet: de app opent alleen het
  ingestelde adres en kan `/health` en `/api/` dan niet bereiken.
- **Herinneringen van meer dan een uur geleden** (toestel stond uit) worden niet alsnog getoond.
- De app plant hooguit 200 herinneringen, tot 30 dagen vooruit; bij elke verversing schuift dat venster mee.
