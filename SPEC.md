# Eigen taken-tool: protocolspecificatie (v0.3)

Een persoonlijke, offline-first takenapp. Deze spec beschrijft het sync-protocol en het datamodel van de referentie-server in `server/`. Ze is gebaseerd op een eerder onderzoek naar de werking van Todoist (niet onderdeel van deze repo), maar is een **eigen ontwerp**: geen Todoist-code, -API of -regeldata is overgenomen.

## 1. Uitgangspunten

- **Eén server, meerdere gebruikers**, eigen beheer. Samenwerken gaat per project: een project wordt gedeeld met andere gebruikers van dezelfde server. Geen workspaces, geen open registratie.
- **Offline-first.** Een client werkt op zijn lokale kopie en synchroniseert wanneer het kan.
- **Eén sync-endpoint** voor alles. Web, PWA en Android spreken hetzelfde protocol.
- **De server is de bron van waarheid**; clients houden een cache en een wachtrij met nog niet bevestigde commando's.
- **Zero dependencies** in server en client (Node 26: `node:sqlite`, `node:http`, `node:test`; in de browser alleen standaard web-API's). Het enige meegeleverde stuk van derden is een Nederlandse datumherkenner (die op `chrono-node` leunt, zie `THIRD_PARTY_NOTICES.md`), als één gebundeld bestand in `client/vendor/`.

## 2. Verschillen met het onderzochte ontwerp, en waarom

| Onderwerp | Todoist (waargenomen) | Hier | Reden |
|---|---|---|---|
| Id's bij aanmaken | tijdelijk id + `temp_id_mapping` terug | **client kiest het id** (8–40 tekens `[A-Za-z0-9_-]`) | Geen vertaalslag, geen `RealIdMapping`, minder foutgevoelig offline |
| Labels op taken | op **naam** | op **id** | Hernoemen raakt één rij, geen cascade over alle taken |
| Volgorde | `child_order` (int) naast `order_key` | alleen `order_key` (fractional indexing) | Eén mechanisme; verplaatsen raakt één rij |
| Realtime | websocket-signaal | **SSE-signaal** (`GET /api/v1/events`) | Zelfde idee (signaal, geen data), zonder dependency |
| Sync-token | opaak | geheel getal (versienummer) als tekst | Eenvoudig en controleerbaar; clients behandelen het als opaak |
| Datumtaal | Dateist op de client | zelfde keuze: **client-side** | De server rekent alleen met gestructureerde herhalingen |
| Commandonamen | `item_*` | `task_*` | Eigen, eenduidige naamgeving |

## 3. Datamodel

Alle entiteiten hebben: `id`, `is_deleted` (bool), `created_at`, `updated_at` (ISO 8601 UTC). Verwijderen is **zacht**: de rij blijft bestaan met `is_deleted: true`, zodat het in een delta meekomt.

| Entiteit | Velden (naast de gemeenschappelijke) |
|---|---|
| `project` | `name`*, `description`, `color`, `parent_id`, `order_key`, `is_favorite`, `is_archived`, `is_collapsed`, `view_style` (list\|board\|calendar) |
| `section` | `project_id`*, `name`*, `description`, `order_key`, `is_archived`, `is_collapsed` |
| `task` | `project_id`*, `section_id`, `parent_id`, `content`*, `description`, `priority` (1 = hoogste … 4 = geen, standaard), `labels` (lijst label-id's), `due`, `deadline` (YYYY-MM-DD), `duration` (minuten), `is_collapsed`, `order_key`; server-beheerd: `checked`, `completed_at`, `completed_count` |
| `label` | `name`* (uniek per eigenaar, niet hoofdlettergevoelig), `color`, `order_key`, `is_favorite`, `owner_id` |
| `comment` | `content`*, precies één van `task_id` / `project_id`, `author_id` |
| `reminder` | `task_id`*, `type`* (`relative` met `minute_offset`, of `absolute` met `due` inclusief tijd), `owner_id` |
| `filter` | `name`*, `query`*, `color`, `order_key`, `is_favorite`, `owner_id` |
| `member` | `project_id`, `user_id`, `role` (`owner` \| `member`). Alleen te wijzigen met `project_share`, `project_unshare` en `project_leave`. |
| `settings` | `auto_reminder` (minuten vooraf; standaard 30; -1 = geen), `timezone` (IANA-naam of `null`), `owner_id`. Eén rij per gebruiker met het vaste id `settings-<gebruikers-id>`; de server maakt hem zelf aan. Alleen `settings_update` bestaat. |

Taken hebben daarnaast `assignee_id` (een lid van het project, of `null`) en `creator_id`. De velden `owner_id`, `creator_id` en `author_id` vult de **server** in met de gebruiker die het commando uitvoert; meesturen geeft `READONLY`.

`*` = verplicht bij aanmaken. `project_id`, `section_id`, `parent_id`, `task_id` wijzig je niet met `*_update`; verplaats een taak met `task_move`.

**`due`**: `{ date, string?, lang?, recurrence? }`. `date` is `YYYY-MM-DD` of `YYYY-MM-DDTHH:MM[:SS]` (zwevend, zonder tijdzone). `string` en `lang` bewaren de oorspronkelijke invoer ("elke vrijdag", `nl`) zodat de client die kan tonen. `recurrence`: `{ freq: daily|weekly|monthly|yearly, interval?: n, byweekday?: [1..7], bymonthday?: 1..31, nth?: 1..4|-1 }`. `byweekday` is ISO (1 = maandag), bij weekly een lijst en bij monthly met `nth` precies één weekdag; `bymonthday` alleen bij monthly of yearly. Met `nth` en één weekdag ontstaat "elke tweede dinsdag van de maand" (`nth: 2`), of "elke laatste vrijdag" (`nth: -1`); een vijfde kent het model niet, omdat die niet elke maand bestaat. `nth` en `bymonthday` sluiten elkaar uit. Met `bymonthday` blijft "elke 31e" de 31e na een korte maand (31 jan, 28 feb, 31 mrt); zonder blijft de dag op de ingekorte waarde hangen.

**Tekst:** alle tekst (namen, titels, beschrijvingen, het `string`-veld van `due`) wordt door de server in Unicode-vorm **NFC** opgeslagen, en de client doet dat ook vóór het versturen, zodat wat optimistisch getoond wordt gelijk is aan wat de server bewaart. Reden: een "é" kan als één teken bestaan of als "e" plus een los accent (zoals sommige toetsenborden het afleveren); voor het oog gelijk, voor een computer niet. **Labelnamen** zijn uniek ongeacht hoofdletters, accenten-vorm en dubbele spaties (vergelijking via `nameKey` in `shared/text.js`, in JavaScript, want SQLite's `lower()` kent alleen ASCII); ze mogen geen komma, omringende spaties of stuurtekens bevatten.

**Sleutels:** `order_key` is een base-62-string zonder eindigende `0`; sorteer gewoon als tekst. De server kent een nieuwe sleutel toe achteraan de lijst als je er geen meegeeft.

## 4. Sync

`POST /api/v1/sync` met `Authorization: Bearer <sessietoken>` (zie hoofdstuk 4a) en JSON-body:

```json
{
  "sync_token": "*",
  "resource_types": ["all"],
  "commands": [ { "type": "task_add", "uuid": "<8-64 tekens>", "args": { "id": "…", "project_id": "…", "content": "…" } } ]
}
```

- `sync_token`: `"*"` voor een volledige sync, anders het token uit het vorige antwoord.
- `resource_types`: `"all"` (standaard) of namen (`tasks`, `projects`, `sections`, `labels`, `comments`, `reminders`, `filters`); `-naam` sluit uit.
- `commands`: maximaal 100, in volgorde uitgevoerd.

Antwoord:

```json
{
  "sync_token": "42",
  "full_sync": false,
  "partial": false,
  "sync_status": { "<uuid>": "ok" },
  "me": { "id": "…", "username": "anna", "name": "Anna", "is_admin": true, "inbox_project_id": "inbox-…" },
  "users": [ { "id": "…", "username": "anna", "name": "Anna" }, … ],
  "tasks": [ … ], "projects": [ … ], "members": [ … ], …
}
```

`me` is de ingelogde gebruiker; `users` bevat die gebruiker plus iedereen met wie een project wordt gedeeld (alleen om namen te tonen), en komt altijd volledig mee.

**Wie wat ziet.** Een gebruiker ziet een project, en de secties, taken, opmerkingen en leden daarvan, als die lid is van het project. Labels, filters en herinneringen ziet alleen de eigenaar; een label van iemand anders is zichtbaar (alleen lezen) zolang het op een taak staat in een project waar je lid van bent. Wat je niet mag zien, bestaat voor jou niet: een commando erop geeft `NOT_FOUND`, niet `FORBIDDEN`.

**Als wat je mag zien verandert,** zorgt de delta daarvoor:
- word je lid van een project, dan bevat je volgende delta **alles** van dat project, ook wat ouder is dan je token;
- word je eruit gehaald of verlaat je het, dan krijg je het project als `{ "id": …, "is_deleted": true }` en ruimt de client alles op wat erbij hoorde (secties, taken, opmerkingen, leden, en herinneringen bij die taken);
- verhuist een taak naar een project dat je niet ziet, dan krijg je die taak (en haar subtaken) als verwijderd;
- verhuist een taak naar een project dat je wel ziet, dan komen haar opmerkingen en je eigen herinneringen erbij mee, ook als die ouder zijn dan je token;
- komt het label van iemand anders op een taak in jouw project, dan komt dat label mee.

**Verwijderde rijen** komen in een delta alleen als `{ "id": …, "is_deleted": true }`, nooit met hun inhoud: een client heeft alleen het id nodig om ze op te ruimen. Word je opnieuw lid van een project waar je eerder lid van was, dan krijg je zo ook te horen wat er in je afwezigheid is verwijderd; van een project waar je nooit lid van was, krijg je niets over wat al verwijderd was.

Elke gebruiker heeft een eigen **Inbox** (`me.inbox_project_id`); ids die met `inbox-` beginnen zijn voor de server gereserveerd.

**Regels**
1. Eén verzoek is één transactie. Elk commando draait in een eigen savepoint: een mislukt commando laat niets achter en breekt de rest niet af. De uitkomst staat in `sync_status[uuid]`: `"ok"` of `{ "error_code", "error" }`.
2. **Idempotent:** een `uuid` wordt per gebruiker hooguit één keer uitgevoerd. Een herhaling krijgt dezelfde uitkomst en verandert niets. De server bewaart uuid's 30 dagen.
3. De delta bevat per type alle rijen met `rev` groter dan het token, **inclusief verwijderde rijen** (die alleen als `{ id, is_deleted: true }` komen). Bij `full_sync: true` zijn verwijderde rijen weggelaten en moet de client zijn lokale kopie vervangen.
4. De server geeft `full_sync: true` ook als het token **vooruit** loopt op de server (database teruggezet), of **ouder** is dan wat de server nog onthoudt over taken die naar een ander project zijn verhuisd (90 dagen; oudere regels worden opgeruimd). Dan moet de client opnieuw beginnen.
5. `partial: true` betekent dat niet alle typen zijn opgevraagd. **Sla in dat geval het nieuwe token niet op.**
6. Wijzigingen die dit verzoek zelf deed, zitten ook in het antwoord; pas ze idempotent toe (upsert op `id`).

**Foutcodes** (`error_code`): `NOT_FOUND`, `FORBIDDEN` (je ziet het wel, maar mag het niet: een label van een ander, een opmerking van een ander, beheer van een project waar je alleen lid van bent), `INVALID_ARG`, `MISSING_ARG`, `UNKNOWN_ARG`, `READONLY`, `IMMUTABLE`, `ID_EXISTS`, `DUPLICATE`, `CONFLICT`, `CYCLE`, `UNKNOWN_COMMAND`, `LIMIT_REACHED` (een grens uit "Limieten" in hoofdstuk 4a is bereikt; de tekst zegt welke), `INTERNAL`. Een ongeldig verzoek als geheel geeft HTTP 400 met `INVALID_REQUEST`; te groot (>1 MiB) geeft 413; geen of fout token geeft 401. Argumenten die dieper dan 16 niveaus nesten, geven `INVALID_ARG`.

**Conflicten:** de volgorde van binnenkomst op de server bepaalt; laatste schrijver wint **per veld dat hij meestuurt**. Een update stuurt alleen gewijzigde velden mee, zodat twee clients die verschillende velden wijzigen elkaar niet overschrijven.

## 5. Commando's

Per entiteit `<entiteit>_add`, `<entiteit>_update`, `<entiteit>_delete` (entiteiten: `project`, `section`, `task`, `label`, `comment`, `reminder`, `filter`), plus:

| Commando | Argumenten | Gedrag |
|---|---|---|
| `task_move` | `id`, en minstens één van `project_id`, `section_id`, `parent_id`; optioneel `order_key` | Verplaatst de taak met al haar subtaken. Naar een ander project zonder opgave: sectie en ouder worden leeg. Een subtaak volgt de sectie van haar ouder. Cirkels en een sectie van een ander project worden geweigerd. |
| `task_complete` | `id`, optioneel `if_due` | Gewone taak: afgevinkt, subtaken ook. **Terugkerend:** de datum schuift naar de volgende keer, de taak blijft open en `completed_count` loopt op. Al afgevinkt: geen wijziging. `if_due` (een datum) is de datum die de afzender zag toen hij afvinkte: heeft een terugkerende taak intussen een andere datum (op een ander apparaat of vanuit de widget van de Android-app al afgevinkt), dan is dit dezelfde afvinkactie en gebeurt er niets. Zo schuift een taak niet twee keer door als twee bronnen hem tegelijk afvinken; voor een gewone taak doet `if_due` niets. De web-app stuurt `if_due` mee bij terugkerende taken en de reducer (`core/reducer.js`) doet lokaal hetzelfde. |
| `task_uncomplete` | `id` | Heropent de taak. |
| `project_share` | `project_id`, `username` | Alleen de eigenaar. Maakt de gebruiker lid van het project en van de subprojecten waar de eigenaar ook eigenaar van is. Onbekend en geblokkeerd geven dezelfde `NOT_FOUND`. De Inbox kan niet. Al lid of jezelf: geen wijziging. |
| `project_unshare` | `project_id`, `user_id` | Alleen de eigenaar; een andere eigenaar of jezelf kan niet. Haalt de persoon uit het project (en de subprojecten waar jij eigenaar van bent); diens toewijzingen vervallen en diens herinneringen bij die taken worden verwijderd. |
| `project_leave` | `project_id` | Voor een lid (niet de eigenaar): zelf vertrekken, met hetzelfde gevolg. |

**Rechten:** wijzigen in een project kan ieder lid. Een project verwijderen of verplaatsen (`parent_id`) en leden beheren kan alleen de eigenaar. Een nieuw project heeft de maker als eigenaar; een subproject krijgt de leden en rollen van het bovenliggende project, en de maker is er altijd eigenaar van. Labels en filters wijzigt alleen de eigenaar, opmerkingen alleen de schrijver. `assignee_id` moet een lid van het project zijn; verhuist de taak naar een project waar die persoon geen lid van is, dan vervalt de toewijzing.

**Cascades bij verwijderen:** project (subprojecten waar je eigenaar van bent, secties, taken, opmerkingen, leden; een subproject van iemand anders komt op het hoogste niveau te staan), sectie (de taken erin), taak (subtaken, opmerkingen, herinneringen van iedereen), label (wordt van alle taken gehaald).

## 4a. Accounts en aanmelden

| Eindpunt | Wie | Wat |
|---|---|---|
| `POST /api/v1/auth/login` `{username, password, device_name}` | iedereen | Geeft `{token, session_id, me}`. Fout wachtwoord, onbekende of geblokkeerde gebruiker: dezelfde `401 INVALID_CREDENTIALS`. Te veel pogingen: `429 TOO_MANY_ATTEMPTS` met `Retry-After` (limieten in hoofdstuk 9). Is de server druk met wachtwoorden controleren: `503 BUSY` met `Retry-After`. Een ingelogd apparaat meer dan de grens (20): het langst ongebruikte wordt afgemeld. |
| `POST /api/v1/auth/logout` | aangemeld | Trekt de sessie van dit apparaat in en sluit diens live-verbinding. |
| `GET /api/v1/auth/me` | aangemeld | `{me}` |
| `POST /api/v1/auth/password` `{current_password, new_password}` | aangemeld | Andere apparaten worden afgemeld; dit apparaat blijft aangemeld. Het raden van het huidige wachtwoord is begrensd (5 foute pogingen per naam en adres, 20 per adres en per naam, per kwartier): `429 TOO_MANY_ATTEMPTS`. |
| `GET /api/v1/auth/sessions`, `POST /api/v1/auth/sessions/revoke {id}` | aangemeld | Eigen apparaten bekijken en afmelden. |
| `GET /api/v1/admin/users`, `POST /api/v1/admin/users {username, name, password, is_admin}` | beheerder | Accounts bekijken en aanmaken. |
| `POST /api/v1/admin/users/update {id, name?, is_admin?, is_disabled?}` | beheerder | Blokkeren meldt overal af. Jezelf blokkeren of degraderen kan niet; er blijft altijd een actieve beheerder. |
| `POST /api/v1/admin/users/password {id, new_password}` | beheerder | Nieuw wachtwoord; alle apparaten van die gebruiker worden afgemeld. |

Gebruikersnamen: 2 tot 40 tekens (letters, cijfers, `.`, `-`, `_`, beginnend met een letter of cijfer), uniek ongeacht hoofdletters en Unicode-vorm. Wachtwoorden: minimaal 10 en maximaal 200 tekens, in NFC, niet gelijk aan de gebruikersnaam en niet te makkelijk te raden (`shared/password.js`, voor server en app): minstens 5 verschillende tekens, niet op de gebruikersnaam lijkend, geen korte herhaling, geen reeks van alleen cijfers korter dan 14 tekens en niet een veelgebruikt wachtwoord of woord uit een lijst (Nederlands en Engels, ook met cijfers of leestekens erachter). Het eerste account is altijd beheerder; neemt bij een database uit v0.1 alle gegevens over.

**Limieten.** Zonder grenzen kan één account, of één lid van een gedeeld project, de server en de sync van anderen vertragen of vol zetten. Een commando dat een grens overschrijdt, geeft `LIMIT_REACHED` met een tekst die zegt welke (verwijderen geeft ruimte terug). De waarden staan in `server/limits.ts`:

| Wat | Grens |
|---|---|
| Projecten waarvan je eigenaar bent (de Inbox telt mee) | 500 |
| Secties per project | 200 |
| Taken per project (ook afgevinkte, niet de verwijderde) | 10.000 |
| Taken per aanmaker, over alle projecten | 50.000 |
| Labels per gebruiker / filters per gebruiker | 500 / 200 |
| Opmerkingen per taak, en bij een project | 500 |
| Herinneringen per taak (eigen) / per gebruiker | 20 / 5.000 |
| Leden per project | 100 |
| Aangemelde apparaten per gebruiker (het langst ongebruikte gaat eruit) | 20 |
| Gelijktijdige live-verbindingen (SSE) per gebruiker (een volgende krijgt `429 TOO_MANY_CONNECTIONS`) | 20 |

Verder: maximaal 100 commando's en 1 MiB per verzoek, argumenten niet dieper dan 16 niveaus genest. De volgordesleutel van een nieuwe rij zoekt de server met een index op (project, sectie, bovenliggende taak, sleutel), zodat toevoegen niet langzamer wordt naarmate een lijst groeit.

## 5a. Herinneringen

Een herinnering hoort bij één taak én één gebruiker (`owner_id`): in een gedeeld project zet ieder zijn eigen herinneringen.

- **Relatief** (`type: "relative"`, `minute_offset`): zoveel minuten vóór het tijdstip van de taak (0 = op het tijdstip). Werkt alleen als de taak een datum **met tijd** heeft; zonder tijd doet ze niets en ze werkt weer zodra er een tijd is.
- **Absoluut** (`type: "absolute"`, `due.date` met tijd): een eigen datum en tijd, los van de taak.
- Datums zijn **zwevend** (`YYYY-MM-DDTHH:MM`, zonder tijdzone): negen uur is negen uur op de plek waar je bent. Pas bij het inplannen wordt het een echt tijdstip, in de tijdzone van de gebruiker (`settings.timezone`; de web-app legt die van het apparaat vast zodra de instellingen binnen zijn) of, voor de server, `DEFAULT_TIMEZONE`. Een tijd die niet bestaat (de overgang naar zomertijd) schuift naar voren, een tijd die twee keer voorkomt (naar wintertijd) telt de eerste. Dit staat in `shared/reminders.js` (met tests rond de overgangen) en is in Kotlin nagebouwd in de Android-app.
- Geen herinnering voor een verwijderde of afgevinkte taak. Een terugkerende taak die wordt afgevinkt schuift naar de volgende keer; relatieve herinneringen schuiven mee.
- **Automatische herinnering** (zoals Todoist): krijgt een taak een tijd en heb je er zelf nog geen herinnering bij, dan komt er een relatieve van `settings.auto_reminder` minuten bij; verdwijnt de tijd, dan vervallen je relatieve herinneringen. Dit doet de **client** (`core/actions.js`), in dezelfde reeks commando's als de wijziging van de taak.
- Verlaat of verdwijnt iemand uit een project, dan vervallen zijn herinneringen bij de taken daarvan.

**Afleveren.** Twee wegen, naast elkaar:

1. **Meldingen in de browser (Web Push, `server/push.ts`)**: de server kijkt elke 20 seconden welke herinneringen aan de beurt zijn en stuurt een versleuteld bericht (RFC 8291) naar de pushdienst van de browser, ondertekend met VAPID (RFC 8292). Elke herinnering gaat per tijdstip één keer; wat hooguit een uur te laat is (bijvoorbeeld na een herstart) gaat alsnog; bij een tijdelijke fout wordt het volgende ronde opnieuw geprobeerd. Alleen bekende pushdiensten zijn toegestaan als bestemming (geen eigen netwerk). Eindpunten (aangemeld, behalve de laatste): `GET /api/v1/push/key`, `POST /api/v1/push/subscribe {endpoint, keys, lang}`, `POST /api/v1/push/unsubscribe {endpoint}`, `GET /api/v1/push/subscriptions`, `POST /api/v1/push/test`, en `POST /api/v1/push/action {token}`. De knoppen in een melding ("Voltooien", "Over 10 minuten") gebruiken het laatste: het token is een ondertekend bewijs (HMAC, een dag geldig) dat precies die ene handeling op die ene taak voor die ene gebruiker toestaat, zodat de browser daarvoor niet ingelogd hoeft te zijn. Het bewijs wordt strikt gelezen: alleen exact de tekst die de server maakte (canoniek base64url, zonder spaties, regeleinden of `=`), en het uuid van de handeling komt uit de handtekening; dezelfde knop doet dus hoe vaak je er ook op drukt, in welke vorm je het bewijs ook aanbiedt, de handeling één keer. Het werkt bovendien alleen zolang de gebruiker nog een aangemeld apparaat met meldingen heeft: na uitloggen, een ingetrokken sessie, een nieuw wachtwoord of blokkeren is het bewijs niet meer geldig, ook al is het nog geen dag oud. De sleutels en het geheim staan in de database van de server (`meta`). Het contactadres voor de pushdienst komt alleen uit `VAPID_SUBJECT`; een tijdzone in `DEFAULT_TIMEZONE` die niet bestaat, geeft bij het opstarten een duidelijke fout.

   Het werk per ronde is begrensd: de database kiest per gebruiker alleen de herinneringen rond dit moment die nog niet zijn verstuurd, een ronde verstuurt er hooguit 200 per gebruiker en houdt een tijdbudget aan van 20 seconden; wat overblijft volgt de volgende ronde. Een gebruiker met heel veel herinneringen vertraagt zo niemand anders.
2. **De Android-app** plant de herinneringen zelf in als lokale alarmen (zie `android/README.md`), zonder pushdienst en zonder Google-diensten; ze gaan dus ook af zonder internet. De web-app in de app praat met de Android-laag via `window.TickoryAndroid` (`core/android.js`): `setSession(token)` bij het starten, na inloggen en `""` bij afmelden; `remindersChanged()` zodra er iets aan taken of herinneringen verandert (kort uitgesteld, één keer per reeks); `notificationStatus()`, `requestNotificationPermission()`, `openNotificationSettings()`, `openBatterySettings()` en `changeServer()`. Een melding opent de taak via `#task=<id>`. De knop "+" van een widget opent het venster Taak toevoegen via `#add` (waar je nu bent), `#add=today` (met vandaag als datum) of `#add=<project-id>`; `core/android.js` leest dat (`addContextFromHash`, alleen veilige tekens). `widgetsChanged()` meldt dat iets verandert dat in de widgets staat (titel, datum, prioriteit, plek, volgorde, projectnamen; `widgetFingerprint`), kort uitgesteld; de app ververst dan de widgets.

**Widgets (Android).** De app heeft vier widgets: Vandaag, Project of lijst (configureerbaar: Inbox, een project, Vandaag of Binnenkort; filters volgen), Binnenkort en een knop Taak toevoegen. Ze zijn gebouwd met `AppWidgetProvider`, `RemoteViews` en een `RemoteViewsService` (geen extra bibliotheken) en lezen uitsluitend gegevens op het toestel, nooit een WebView of het netwerk.

- *Gegevens.* Elke verversing (`SyncWorker`: na inloggen, bij openen van de app, na `remindersChanged()`/`widgetsChanged()`, elk kwartier met verbinding) vraagt naast taken en herinneringen ook `projects`, `sections` en `labels` op en bewaart de open taken, projecten, secties en labels van de gebruiker in `widget-cache.json` (privé-opslag, atomair geschreven), met het gebruikers-id uit `me`. De server stuurt alleen wat de gebruiker mag zien; de widget voegt niets toe, dus wie geen lid meer is van een gedeeld project, ziet het na de volgende verversing niet meer.
- *Wie.* Afmelden of een ander serveradres wist alle gegevens en de wachtrij. Een ander token (nieuwe aanmelding) maakt de gegevens "ongecontroleerd": de widgets tonen niets tot de eerstvolgende verversing laat zien van wie ze zijn; is het een ander gebruikers-id, dan worden gegevens en wachtrij vervangen, is het dezelfde, dan blijft de wachtrij. Een wachtrij van een ander id wordt nooit verstuurd.
- *Weergave.* Vandaag = open taken met een datum op of vóór vandaag (tijdzone van het toestel), eerst op `due.date`, dan prioriteit, dan `order_key`, zoals `todayView`; Binnenkort = vanaf morgen 14 dagen, per dag; een project = per sectie, als boom. Zwevende datums blijven wat ze zijn: 14:00 is 14:00 op het toestel.
- *Afvinken.* Een tik op de cirkel zet `{taak, uuid, if_due, gebruiker, tijd}` in een duurzame wachtrij (`widget-queue.json`; één regel per taak, dubbel tikken is één actie; uuid `tickory-w-<24 hex>`, per actie, bij opnieuw proberen hetzelfde) en verbergt de taak (en bij een gewone taak de subtaken) in alle widgets. Er wordt geen datum verzonnen: een terugkerende taak komt terug met de datum die de server na `task_complete` geeft. `SyncWorker` stuurt de wachtrij (hooguit 50 per verzoek) als `task_complete` naar `POST /api/v1/sync` vóór hij ophaalt; `ok` en elke weigering (`NOT_FOUND`, `FORBIDDEN`, ...) halen de regel uit de wachtrij, een netwerkfout of tijdelijke serverfout laat hem staan (WorkManager probeert opnieuw, met netwerkvoorwaarde en oplopende pauzes), `401` laat hem staan en markeert de sessie als verlopen, een regel ouder dan drie dagen vervalt. Kent de server `if_due` niet (`UNKNOWN_ARG`), dan gaat dezelfde actie opnieuw zonder, met een nieuw uuid. Herinneringen, uitstel en meldingen van de taak vervallen meteen (`ReminderEngine.onCompletedLocally`).
- *Klok.* Eén onnauwkeurig alarm per dag (kort na middernacht), plus `updatePeriodMillis` en de systeemgebeurtenissen voor tijd, tijdzone en taal, laten de widgets zich opnieuw tekenen uit de gegevens op het toestel.
- *Veiligheid.* Providers en de lijstservice zijn niet exporteerbaar (de service vraagt `BIND_REMOTEVIEWS`); alleen het configuratiescherm is exporteerbaar (Android moet het starten) en controleert het widget-id. Intenties zijn expliciet en `FLAG_IMMUTABLE`, behalve het sjabloon van de lijst (`FLAG_MUTABLE`, nodig om per regel de taak in te vullen), dat naar een niet-exporteerbaar scherm zonder weergave wijst dat elk id controleert. Er komt geen taakinhoud in het logboek.

## 6. Realtime

`GET /api/v1/events` (SSE; token **alleen via de `Authorization`-header**, nooit in de URL: de client leest de stroom met `fetch` in plaats van `EventSource`). Gebeurtenissen: `hello` (`{}`) en `sync_needed` na elke wijziging. Het signaal draagt **geen data** en geen versienummer: dat telt over alle gebruikers samen en zou verraden hoeveel anderen doen. De client haalt een delta op, en negeert signalen met zijn eigen `client_id` (header `X-Client-Id` bij het sync-verzoek): alleen de apparaten van de gebruiker die de wijziging deed krijgen `{ "client_id": … }`, anderen `{}`. Het signaal gaat **alleen naar de gebruikers die de wijziging zien** (leden van de betrokken projecten, ook wie er net uit is gehaald, en de eigenaar van labels, filters, herinneringen en instellingen), niet naar iedereen. Een gebruiker kan hooguit 20 verbindingen tegelijk openen; een volgende krijgt `429 TOO_MANY_CONNECTIONS` (de client probeert het later opnieuw). Bij het heropenen van de verbinding: ook een delta ophalen. Een wijziging via de opdrachtregel (`user passwd`, `disable`, `logout-all`) is een ander proces: een lopende verbinding sluit dan pas bij de volgende ping (hooguit 25 seconden), niet direct zoals bij een wijziging via de API.

Het `sync_token` zelf is wel een globaal versienummer. Wie synchroniseert ziet dat het oploopt, en kan zo raden hoeveel wijzigingen er in totaal op de server gebeuren; dat is een bekende beperking van dit ontwerp (een token per gebruiker vraagt een ander protocol).

## 7. Clientalgoritme

1. Lokaal bewaren: de gegevens per type op `id`, het `sync_token` en een **wachtrij** commando's (met `uuid`).
2. Wijziging: pas lokaal toe en zet het commando in de wachtrij.
3. Synchroniseren (bij start, wijziging, `sync_needed`, terug online): stuur de wachtrij en het token. Verwijder bevestigde commando's (`"ok"` of een permanente fout, na tonen aan de gebruiker). Bij netwerkfout: bewaar de wachtrij en herhaal later met **dezelfde uuid's**.
4. Verwerk het antwoord: upsert elke rij op `id`; `is_deleted` verwijdert lokaal. `full_sync`: lokale kopie eerst leegmaken. Sla `sync_token` op tenzij `partial`.
5. Eerste sync mag gefaseerd (taken en projecten eerst) via `resource_types`; sla het token pas op na de laatste fase.

### Tijdslimieten

Elk sync-verzoek heeft een limiet van 30 seconden; daarna wordt het afgebroken, telt het als "offline" en volgt een nieuwe poging met oplopende wachttijd (2 s tot 60 s). Zonder limiet blokkeert één verzoek zonder antwoord (een halfopen verbinding, een tussenliggend filter) de sync voorgoed, omdat er maar één tegelijk loopt. Het realtime-kanaal wordt opnieuw opgezet als er 70 seconden niets binnenkomt; de server stuurt elke 25 seconden een ping.

## 8. De web-app (client)

`client/` is een installeerbare web-app (PWA) zonder build-stap; de server levert haar uit op `/`.

| Onderdeel | Bestand | Taak |
|---|---|---|
| Slepen en verplaatsen | `core/dnd.js`, `ui/dragdrop.js`, `dnd.css` | Taken en projecten verplaatsen met muis, pen, aanraking (lang indrukken of handvat) en `Alt` + pijl, met aankondiging (aria-live). `core/dnd.js` bepaalt zonder scherm waar iets terechtkomt en welke `order_key` het krijgt (ook bij buren met dezelfde sleutel: die krijgen nieuwe sleutels via `task_update`/`project_update`); alleen de eigenaar verplaatst een project. De uitvoering loopt via `actions.moveTask` en `moveProject`, dus optimistisch en offline |
| Optimistische uitvoering | `core/reducer.js` | Past commando's lokaal toe volgens dezelfde regels als de server |
| Opslag | `core/store.js`, `core/idb.js` | Laatst bevestigde toestand plus wachtrij in IndexedDB; atomaire commits; wachtrijsleutel `[volgnummer, tabblad]` zodat twee tabbladen elkaar niet overschrijven |
| Synchronisatie | `core/syncClient.js`, `core/events.js` | Verzenden in porties van 100 (bij HTTP 413 kleinere), tijdslimieten, realtime-signaal |
| Handelingen | `core/actions.js` | Gebruikershandelingen worden commando's, met id's en volgordesleutels |
| Datumtaal | `core/dateNl.js` | In drie lagen: herhalingen (eigen regels, ook de n-de weekdag van de maand, dagdelen, "elk jaar op 5 december"); eenmalige datums via de meegebundelde herkenner; Nederlandse aanvullingen daarop (dag met maandnaam, begin/midden/eind van een maand, feestdagen met voorzetsel, Pasen berekend, "deze week", IJ-hoofdletter). Zie README, hoofdstuk "Nederlands" |
| Meldingen | `core/messages.js` | Foutcodes van de server worden begrijpelijk Nederlands, zonder technische veldnamen |
| Snel toevoegen | `core/quickadd.js` | `#project`, `/sectie`, `@label`, `p1` tot `p4` of `!!1` tot `!!4`, `{deadline}`, datum in gewone taal; `~` zet de herkenning uit |
| Overzichten | `core/selectors.js` | Project (secties, subtaken), Vandaag (te laat apart), Binnenkort; de projectenboom voor de zijbalk (`navProjects`, `favoriteProjects`, `archivedList`, `isArchivedProject`, `projectDescendantIds`), subtaak- en opmerkingtellers (`subtaskCounts`, `commentCounts`), `foldRows` voor ingeklapte taken, en `commentsOf` |
| Regel van de takenlijst | `core/rowModel.js` | Wat één regel toont, als gewone gegevens: chips voor datum, deadline, subtaken (`1/4`), opmerkingen, labels, belletje en toewijzing, de eerste regel van de beschrijving, initialen. De interface tekent een regel opnieuw als en alleen als deze gegevens veranderen |
| Kleuren | `core/colors.js`, klassen `.pc-<naam>` in `app.css` | Het veld `color` van projecten, labels en filters is een naam uit een palet van zestien: `charcoal` (standaard), `red`, `orange`, `amber`, `olive`, `green`, `mint`, `teal`, `sky`, `blue`, `indigo`, `violet`, `magenta`, `rose`, `brown`, `grey`. Een onbekende naam geldt als `charcoal`. Elke kleur heeft een tint voor licht en donker; de test controleert dat `app.css` precies deze kleuren bevat en dat elke kleur 3:1 contrast heeft |
| Snelle datums | `core/quickDates.js` | Vandaag, morgen, dit weekend (zaterdag), volgende week (maandag) en geen datum; `reschedule` verzet een taak en laat tijdstip en herhaling staan |
| Tijd in woorden | `core/timeAgo.js` | "zojuist", "2 uur geleden", daarna een datum; voor opmerkingen en de regel "Gemaakt door" |
| Tekst van opmerkingen | `core/commentText.js` | Splitst een opmerking in tekst en `http(s)`-adressen; de interface maakt er gewone tekstlinks van (nooit HTML, `rel="noopener noreferrer nofollow"`) |
| Sneltoetsen | `core/shortcuts.js` | `q`, `g` dan `t`/`u`/`i` (1,5 s voor de tweede toets), `?`; doet niets in een invoerveld, met Ctrl, Cmd of Alt, of als er een venster open staat. `/` en `Ctrl+K` blijven vrij voor zoeken |
| Taal van de interface | `core/i18n.js`, `i18n/nl.js`, `i18n/en.js` | `t('sleutel', { invulveld })` met meervoud; keuze: bewaarde voorkeur (`tickory.lang`), dan de talen van de browser, anders Nederlands. De datumtaal die je intypt is een ander onderwerp en voorlopig alleen Nederlands |
| Herinneringen | `shared/reminders.js`, `core/reminderText.js`, `ui/reminderUi.js` | Tijdstip van een herinnering, de teksten, het stuk in het taakvenster en het scherm Herinneringen en meldingen |
| Meldingen | `core/push.js`, `core/android.js`, `sw.js` | Aan- en uitzetten van meldingen in de browser, de brug naar de Android-app, en de service worker die een bericht als melding toont |
| Filters en zoeken | `core/filter.js`, `core/search.js` | De logica van de filtertaal (Nederlands en Engels) en van zoeken; nog zonder schermen |
| Zijbalk en takenlijst | `ui/render.js`, `ui/icons.js` | Tekent de zijbalk, de kop en de lijst uit de lokale toestand; eigen pictogrammen als inline SVG (geen bestanden, geen lettertype) |
| Taakvenster | `ui/taskDialog.js` | Groot venster in twee kolommen (titel, beschrijving, subtaken, opmerkingen links; eigenschappen rechts); subtaken, opmerkingen en herinneringen gaan direct door, de rest met Opslaan |
| Opmerkingen | `ui/comments.js` | De lijst, het invoerveld en bewerken en verwijderen van je eigen opmerkingen, bij een taak of een project |
| Project maken en bewerken | `ui/projectDialog.js` | Naam, kleur (zestien keuzerondjes), favoriet, en bij een nieuw project "Subproject van" |
| Taak toevoegen (venster) | `ui/quickAdd.js` | De voorvertoning van de invoerregel (ook voor de balk bovenaan) en het venster met beschrijving en projectkeuze |
| Kleine vensters | `ui/miscDialogs.js` | Sneltoetsenoverzicht, gearchiveerde projecten, opmerkingen bij een project, een andere dag kiezen voor een taak |
| Offline | `sw.js` | Bewaart alle bestanden van de app en vult de bewaarde kopie vanzelf aan als die gewist is |

**Optimistisch rekenen.** De weergave is altijd *bevestigde toestand plus wachtrij*. Na elk sync-antwoord wordt de bevestigde toestand vervangen en de nog niet bevestigde wachtrij er opnieuw op toegepast. Een wijziging van een ander apparaat overschrijft dus nooit een wijziging die nog moet worden verstuurd.

**Zelfde weigeringen als de server.** De reducer voert een `task_move` met een cirkel, een sectie of ouder van een ander project of een ongeldige sleutel niet door, laat de toewijzing vervallen als de nieuwe projectleden de persoon niet bevatten, en voert een `project_update` met een nieuwe `parent_id` niet door voor een lid, bij een cirkel of onder de Inbox. De differentiële test en `dndSync.test.js` controleren dat.

**Geweigerde wijzigingen.** Weigert de server een commando (bijvoorbeeld omdat de taak intussen elders is verwijderd), dan verdwijnt het uit de wachtrij, valt de weergave terug op de werkelijke toestand en toont de app de reden.

**Zijbalk en navigatie.** De zijbalk toont van boven naar beneden: het merk, de knop "Taak toevoegen" (opent het venster, sneltoets `q`), een lege plek `#sidebar-search`, de weergaven Inbox, Vandaag en Binnenkort, een lege plek `#sidebar-extra`, de favorieten, de projectenboom en (alleen als er gearchiveerde projecten zijn) "Gearchiveerde projecten", en onderaan de gebruiker met Instellingen en het toetsenbordpictogram. De Inbox staat dus niet onder Projecten. In de boom heeft een project met subprojecten een pijltje dat `is_collapsed` van het project wijzigt (het hoort bij het project en geldt dus voor alle leden); de subprojecten van een ingeklapt project staan er niet in, en een project onder een gearchiveerd project verdwijnt ook (`isArchivedProject`). Archiveren zet `is_archived` op het project en al zijn subprojecten; terugzetten doet het omgekeerde. De eerder bekeken weergave wordt per apparaat in `localStorage` (`tickory.route`) onthouden.

**Aanhaakpunten voor zoeken, filters en labels.** `ui/render.js` exporteert `sidebarHooks`, een lijst functies. `sidebar()` maakt `#sidebar-search` (onder de knop "Taak toevoegen") en `#sidebar-extra` (onder Binnenkort, vóór Favorieten) bij elke keer tekenen opnieuw leeg aan; `ui/app.js` roept direct daarna elke aangemelde functie aan met `{ search, extra }`. Een onderdeel meldt zich één keer aan met `sidebarHooks.push(({ search, extra }) => { … })`. In de kop van de pagina is `#topbar-tools` (in `index.html`) de vaste plek voor een zoekveld in het midden; die wordt niet opnieuw getekend.

**Takenlijst.** De lijst is één element met één set luisteraars (`bindList`): afvinken, openen, in- en uitklappen van subtaken en de snelle knoppen (bewerken, andere dag, verwijderen) lopen via `data-act`, zodat duizenden regels geen duizenden luisteraars kosten. Getekende regels worden bewaard per taak-id zolang hun gegevens (`rowModel`) gelijk blijven. De snelle knoppen worden pas gemaakt als je een regel aanwijst of er met het toetsenbord in komt. Het rondje heeft de kleur van de prioriteit (P1 rood, P2 oranje, P3 blauw, P4 grijs); een taak die je afvinkt verdwijnt na een korte animatie (niet bij "minder beweging"). Secties en taken met subtaken klappen in en uit via `is_collapsed`. Op een smal scherm (tot 760 px) is de zijbalk een schuifmenu en neemt het taakvenster het hele scherm in.

**Opmerkingen.** Een opmerking hoort bij precies één taak of één project (`task_id` of `project_id`). De schrijver (`author_id`) vult de server in; de client wijzigt of verwijdert alleen eigen opmerkingen en de server weigert andermans wijzigingen. De tekst gaat altijd als tekst het document in; webadressen worden gewone tekstlinks.

## 9. Beveiliging

- Wachtwoorden met **scrypt** (N=2^15, r=8, p=1, eigen salt; de kosten staan in de hash, zodat ze later omhoog kunnen; bestaande hashes worden bij het inloggen niet automatisch vernieuwd). Een onbekende gebruikersnaam kost evenveel rekentijd als een bekende. Naast de lengte-eis weert de server wachtwoorden die te makkelijk te raden zijn (zie hoofdstuk 4a).
- **Sessies:** per apparaat een willekeurig token van 256 bits (`tky_…`); de database bewaart alleen de SHA-256 ervan, dus een gelekte database of back-up geeft geen werkende sessies. Uitloggen, een nieuw wachtwoord, blokkeren en intrekken via de API werken direct, ook voor open live-verbindingen. Een wijziging via de opdrachtregel (`user passwd`, `disable`, `logout-all`) trekt de sessies direct in, maar een lopende live-verbinding sluit dan pas bij de volgende ping (hooguit 25 seconden). Sessies verlopen niet vanzelf; trek een apparaat dat je kwijt bent in via Account. Hooguit 20 apparaten per gebruiker: bij het volgende inloggen gaat het langst ongebruikte eruit.
- **Inlogpogingen beperkt**, per kwartier: 8 per combinatie van gebruikersnaam en adres, 40 per adres (bij IPv6 per /64) en 60 per gebruikersnaam over alle adressen. Een poging wordt geteld **voordat** het wachtwoord wordt gecontroleerd (de controle is asynchroon; tellen erna liet honderden gelijktijdige pogingen door de beperking), en geeft zijn plek terug als het wachtwoord klopt. Een aanvaller van één adres kan zo het account van een ander niet vergrendelen: de eigenaar komt van een ander adres en heeft zijn eigen teller. Scrypt draait met hooguit twee berekeningen tegelijk (de rest wacht, tot 32; daarboven `503 BUSY`), zodat een stroom inlogverzoeken de server niet platlegt. Het huidige wachtwoord raden bij een wachtwoordwijziging heeft een eigen, strengere limiet. De tellers staan in het geheugen en verdwijnen bij een herstart. Achter een eigen proxy telt met `TRUST_PROXY=1` het adres uit `X-Forwarded-For` (de laatste waarde).
- **Limieten** per gebruiker en per project (hoofdstuk 4a) begrenzen wat één account kan opslaan en wat de server per ronde doet; ze staan bewust niet in de omgeving maar in `server/limits.ts`.
- Elke toegangsregel uit hoofdstuk 4 en 5 is getest, en gecontroleerd met opzettelijk gebroken code (elke gebroken regel laat een test falen).
- **Meldingen:** een apparaat meldt zelf het adres van zijn pushdienst; dat mag nooit naar een willekeurige server wijzen (dan zou de server verzoeken doen aan je thuisnetwerk). Alleen bekende pushdiensten, via https op poort 443 en nooit een IP-adres, zijn toegestaan; verder uit te breiden met `PUSH_ALLOWED_HOSTS` (komma-gescheiden domeinen, bijvoorbeeld een eigen pushdienst). Omleidingen worden niet gevolgd. De knoppen in een melding gebruiken een ondertekend bewijs per taak en handeling dat een dag geldig is, strikt gelezen en niet meer geldig zodra het apparaat is afgemeld (zie 5a). De privésleutel van de server voor meldingen (VAPID) én het geheim waarmee de bewijzen voor de knoppen worden ondertekend (HMAC) staan in de database en dus ook in een back-up: wie die heeft, kan bewijzen voor elke taak van elke gebruiker maken. Bewaar een back-up net zo zorgvuldig als de database.
- **Android-widgets:** de taken staan voor de widgets in de privé-opslag van de app (niet versleuteld, niet in back-ups, net als het plan van de herinneringen); het token blijft in de Keystore. Zie hoofdstuk 5a voor wat er bij afmelden, een ander account en een gedeeld project gebeurt.
- **Android-app:** het sessietoken wordt met een sleutel uit de Android Keystore versleuteld bewaard; dat geldt voor de kopie die de app zelf gebruikt (herinneringen op de achtergrond). De web-app in de WebView bewaart haar eigen kopie van het token in `localStorage`, zoals elke browser doet: in de privé-opslag van de app, niet versleuteld, en niet in back-ups; wie het toestel root of de app-gegevens kan lezen, kan dat token dus ook lezen. De brug naar de web-app werkt alleen als de geladen pagina van het ingestelde serveradres komt; de app maakt alleen verbinding via https, of via http op het eigen netwerk (of het toestel zelf): een http-adres naar een server op internet wordt geweigerd, ook bij een adres dat in een oudere versie is ingesteld; de app vraagt alleen de toestemmingen die hij nodig heeft; geen Google-diensten, geen statistieken, geen "Safe Browsing"-controle bij Google. Een release-APK is altijd met de eigen sleutel getekend; de bouw mislukt zonder sleutel, er komt nooit een debug-APK in een openbare Release.
- Luistert standaard op `127.0.0.1`. Zet er voor gebruik buiten je netwerk een reverse proxy met **TLS** voor; wachtwoord en sessietoken reizen anders in de open lucht.
- **Voor een telefoon heb je HTTPS nodig.** Browsers staan service workers (offline gebruik) en installeren als app alleen toe op een beveiligde herkomst; alleen `localhost` is daarop een uitzondering.
- Het sessietoken staat nooit in een URL, dus ook niet in toegangslogs van een proxy.
- De web-app wordt met een strikte Content-Security-Policy geleverd (alleen eigen bronnen, geen inline scripts of stijlen, niet in een frame te laden). Bestanden komen alleen uit twee vaste mappen; padtraversal, verborgen bestanden, testbestanden (ook met andere hoofdletters) en Windows-apparaatnamen worden geweigerd. De service worker bewaart alleen de eigen bestanden uit zijn lijst, en voor een navigatie alleen de app-pagina `/`: een link naar een ander bestand van de server kan de bewaarde app niet vervangen.
- Body maximaal 1 MiB, verzoektimeout 30 s, alle SQL gebruikt gebonden parameters. Lijsten met waarden in een query groeien niet met de gegevens mee (brokken van 500 of een subquery), want SQLite staat er hooguit 32766 in één query toe.
- **Het live-signaal** gaat alleen naar de gebruikers die de wijziging zien, zonder versienummer (hoofdstuk 6).
- **Verwijderde rijen** gaan nooit met hun inhoud mee in een delta (hoofdstuk 4). De inhoud van verwijderde taken blijft wel in de database en in back-ups staan; er is nog geen opruiming.
- **Het eerste account** komt uit `TODO_ADMIN_USER` met `TODO_ADMIN_PASSWORD` of `TODO_ADMIN_PASSWORD_FILE` (een bestand, bijvoorbeeld een Docker-secret; een eindregel telt niet mee), alleen bij de allereerste start. Het wachtwoord uit de omgeving blijft in de configuratie van de container staan (`docker inspect` toont het): haal het na de eerste start uit `.env` en maak de container opnieuw aan, of gebruik het bestand.
- Back-up: `node server/backup.ts <doel.db>` maakt een consistente kopie terwijl de server draait. Een kopie bevat alle gegevens van alle gebruikers, de wachtwoord-hashes, de (gehashte) sessies en de sleutels van de server voor meldingen (de VAPID-privésleutel en het HMAC-geheim): bewaar hem net zo zorgvuldig als de database. De bestandsrechten van een kopie zijn die van het bestandssysteem (SQLite maakt standaard een leesbaar bestand); zet de map met kopieën zelf dicht.

## 10. Nog niet gebouwd

| Onderdeel | Opmerking |
|---|---|
| Android-app (APK): getest op een echt toestel | De app bouwt, de tests slagen (zie `android/README.md`) en lint is schoon, maar niets is op een telefoon of emulator gedraaid (de emulator kon op de ontwikkelmachine niet starten). Alarmen in de slaapstand en bij strenge merken, de toestemmingsvragen en de echte WebView zijn alleen op een toestel te controleren |
| Android-widgets: getest op een echt toestel | Gebouwd en getest op een nagebootste Android (gegevens, wachtrij, tekenen, configuratiescherm). Het uiterlijk per launcher, het aanpassen van het formaat, dynamische kleuren, tikken op de cirkel (een scherm zonder weergave start kort) en gedrag onder stroombesparing zijn alleen op een toestel te controleren; `android/README.md` heeft een korte testlijst |
| Filters in een widget | De keuzelijst van "Project of lijst" (`WidgetChoices`) en de bron (`WidgetSource.Filter`) zijn ervoor voorbereid; de filtertaal (`core/filter.js`) is nog niet in Kotlin nagebouwd |
| Herhalingen als gesproken of getypte zin in het taakvenster | Het datumveld leest ze al ("elke ma en do"); een kiezer met knoppen ontbreekt |
| Herkennen van een teruggezette database | Het token is nu alleen een versienummer. Een `epoch` (willekeurige waarde, per database) in het token zou een teruggezette of vervangen database altijd een volledige sync laten afdwingen, ook als het versienummer toevallig weer voorbij de stand van een apparaat is gegroeid |
| Schermen voor filters en zoeken | De logica staat klaar (`core/filter.js`, `core/search.js`, `addFilter`/`renameLabel` in `core/actions.js`); er is nog geen zoekveld, filterscherm of labelbeheer |
| Vandaag-volgorde en weergave-opties | Aparte entiteiten, vergelijkbaar met `day_orders` en `view_options` uit het onderzoek |
| Herinneringen op een locatie, per e-mail, en Engelse datumtaal voor herinneringen | Alleen op tijd, in de app en als melding. Wat je intypt is voorlopig Nederlands (`!(morgen om 8 uur)`); `!30m` en een datum in de vorm `2026-12-31T14:30` werken in elke taal |
| De duur van een taak, bord- en kalenderweergave | Staan als veld of entiteit in het datamodel en worden gesynchroniseerd; de app heeft er geen scherm voor. (Opmerkingen, subprojecten, favorieten, kleuren en archiveren hebben sinds het nieuwe uiterlijk wel een scherm; zie hoofdstuk 8.) |
| Bijlagen, activiteitenlog, voltooide taken met paginering | Voltooide taken blijven nu in `tasks` met `checked: true` |
| Persoonlijke projectvoorkeuren in gedeelde projecten | Volgorde in de zijbalk, favoriet en ingeklapt horen nu bij het project en gelden dus voor alle leden |
| Eigenaarschap overdragen, uitnodigen via link of e-mail | Delen gaat nu op gebruikersnaam; een eigenaar kan een project alleen verwijderen, niet overdragen |
| Opruimen van verwijderde rijen, instemming bij delen | Verwijderde taken, secties en opmerkingen blijven (zonder inhoud in de delta) in de database en in back-ups staan; een eigenaar kan iedere bestaande gebruiker meteen aan een project toevoegen, zonder dat die eerst moet instemmen (verlaten kan altijd) |
