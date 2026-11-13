# Eigen taken-tool: protocolspecificatie (v0.2)

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
- komt het label van iemand anders op een taak in jouw project, dan komt dat label mee.

Elke gebruiker heeft een eigen **Inbox** (`me.inbox_project_id`); ids die met `inbox-` beginnen zijn voor de server gereserveerd.

**Regels**
1. Eén verzoek is één transactie. Elk commando draait in een eigen savepoint: een mislukt commando laat niets achter en breekt de rest niet af. De uitkomst staat in `sync_status[uuid]`: `"ok"` of `{ "error_code", "error" }`.
2. **Idempotent:** een `uuid` wordt per gebruiker hooguit één keer uitgevoerd. Een herhaling krijgt dezelfde uitkomst en verandert niets. De server bewaart uuid's 30 dagen.
3. De delta bevat per type alle rijen met `rev` groter dan het token, **inclusief verwijderde rijen**. Bij `full_sync: true` zijn verwijderde rijen weggelaten en moet de client zijn lokale kopie vervangen.
4. De server geeft `full_sync: true` ook als het token **vooruit** loopt op de server (database teruggezet). Dan moet de client opnieuw beginnen.
5. `partial: true` betekent dat niet alle typen zijn opgevraagd. **Sla in dat geval het nieuwe token niet op.**
6. Wijzigingen die dit verzoek zelf deed, zitten ook in het antwoord; pas ze idempotent toe (upsert op `id`).

**Foutcodes** (`error_code`): `NOT_FOUND`, `FORBIDDEN` (je ziet het wel, maar mag het niet: een label van een ander, een opmerking van een ander, beheer van een project waar je alleen lid van bent), `INVALID_ARG`, `MISSING_ARG`, `UNKNOWN_ARG`, `READONLY`, `IMMUTABLE`, `ID_EXISTS`, `DUPLICATE`, `CONFLICT`, `CYCLE`, `UNKNOWN_COMMAND`, `INTERNAL`. Een ongeldig verzoek als geheel geeft HTTP 400 met `INVALID_REQUEST`; te groot (>1 MiB) geeft 413; geen of fout token geeft 401.

**Conflicten:** de volgorde van binnenkomst op de server bepaalt; laatste schrijver wint **per veld dat hij meestuurt**. Een update stuurt alleen gewijzigde velden mee, zodat twee clients die verschillende velden wijzigen elkaar niet overschrijven.

## 5. Commando's

Per entiteit `<entiteit>_add`, `<entiteit>_update`, `<entiteit>_delete` (entiteiten: `project`, `section`, `task`, `label`, `comment`, `reminder`, `filter`), plus:

| Commando | Argumenten | Gedrag |
|---|---|---|
| `task_move` | `id`, en minstens één van `project_id`, `section_id`, `parent_id`; optioneel `order_key` | Verplaatst de taak met al haar subtaken. Naar een ander project zonder opgave: sectie en ouder worden leeg. Een subtaak volgt de sectie van haar ouder. Cirkels en een sectie van een ander project worden geweigerd. |
| `task_complete` | `id` | Gewone taak: afgevinkt, subtaken ook. **Terugkerend:** de datum schuift naar de volgende keer, de taak blijft open en `completed_count` loopt op. Al afgevinkt: geen wijziging. |
| `task_uncomplete` | `id` | Heropent de taak. |
| `project_share` | `project_id`, `username` | Alleen de eigenaar. Maakt de gebruiker lid van het project en van de subprojecten waar de eigenaar ook eigenaar van is. Onbekend en geblokkeerd geven dezelfde `NOT_FOUND`. De Inbox kan niet. Al lid of jezelf: geen wijziging. |
| `project_unshare` | `project_id`, `user_id` | Alleen de eigenaar; een andere eigenaar of jezelf kan niet. Haalt de persoon uit het project (en de subprojecten waar jij eigenaar van bent); diens toewijzingen vervallen en diens herinneringen bij die taken worden verwijderd. |
| `project_leave` | `project_id` | Voor een lid (niet de eigenaar): zelf vertrekken, met hetzelfde gevolg. |

**Rechten:** wijzigen in een project kan ieder lid. Een project verwijderen of verplaatsen (`parent_id`) en leden beheren kan alleen de eigenaar. Een nieuw project heeft de maker als eigenaar; een subproject krijgt de leden en rollen van het bovenliggende project, en de maker is er altijd eigenaar van. Labels en filters wijzigt alleen de eigenaar, opmerkingen alleen de schrijver. `assignee_id` moet een lid van het project zijn; verhuist de taak naar een project waar die persoon geen lid van is, dan vervalt de toewijzing.

**Cascades bij verwijderen:** project (subprojecten waar je eigenaar van bent, secties, taken, opmerkingen, leden; een subproject van iemand anders komt op het hoogste niveau te staan), sectie (de taken erin), taak (subtaken, opmerkingen, herinneringen van iedereen), label (wordt van alle taken gehaald).

## 4a. Accounts en aanmelden

| Eindpunt | Wie | Wat |
|---|---|---|
| `POST /api/v1/auth/login` `{username, password, device_name}` | iedereen | Geeft `{token, session_id, me}`. Fout wachtwoord, onbekende of geblokkeerde gebruiker: dezelfde `401 INVALID_CREDENTIALS`. Te veel pogingen: `429 TOO_MANY_ATTEMPTS` met `Retry-After`. |
| `POST /api/v1/auth/logout` | aangemeld | Trekt de sessie van dit apparaat in en sluit diens live-verbinding. |
| `GET /api/v1/auth/me` | aangemeld | `{me}` |
| `POST /api/v1/auth/password` `{current_password, new_password}` | aangemeld | Andere apparaten worden afgemeld; dit apparaat blijft aangemeld. |
| `GET /api/v1/auth/sessions`, `POST /api/v1/auth/sessions/revoke {id}` | aangemeld | Eigen apparaten bekijken en afmelden. |
| `GET /api/v1/admin/users`, `POST /api/v1/admin/users {username, name, password, is_admin}` | beheerder | Accounts bekijken en aanmaken. |
| `POST /api/v1/admin/users/update {id, name?, is_admin?, is_disabled?}` | beheerder | Blokkeren meldt overal af. Jezelf blokkeren of degraderen kan niet; er blijft altijd een actieve beheerder. |
| `POST /api/v1/admin/users/password {id, new_password}` | beheerder | Nieuw wachtwoord; alle apparaten van die gebruiker worden afgemeld. |

Gebruikersnamen: 2 tot 40 tekens (letters, cijfers, `.`, `-`, `_`, beginnend met een letter of cijfer), uniek ongeacht hoofdletters en Unicode-vorm. Wachtwoorden: minimaal 10 tekens, niet gelijk aan de gebruikersnaam, in NFC. Het eerste account is altijd beheerder; neemt bij een database uit v0.1 alle gegevens over.

## 6. Realtime

`GET /api/v1/events` (SSE; token **alleen via de `Authorization`-header**, nooit in de URL: de client leest de stroom met `fetch` in plaats van `EventSource`). Gebeurtenissen: `hello` (huidige `rev`) en `sync_needed` (`{ client_id, rev }`) na elke wijziging. Het signaal draagt **geen data**: de client haalt een delta op, en negeert signalen met zijn eigen `client_id` (header `X-Client-Id` bij het sync-verzoek). Bij het heropenen van de verbinding: ook een delta ophalen.

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
| Optimistische uitvoering | `core/reducer.js` | Past commando's lokaal toe volgens dezelfde regels als de server |
| Opslag | `core/store.js`, `core/idb.js` | Laatst bevestigde toestand plus wachtrij in IndexedDB; atomaire commits; wachtrijsleutel `[volgnummer, tabblad]` zodat twee tabbladen elkaar niet overschrijven |
| Synchronisatie | `core/syncClient.js`, `core/events.js` | Verzenden in porties van 100 (bij HTTP 413 kleinere), tijdslimieten, realtime-signaal |
| Handelingen | `core/actions.js` | Gebruikershandelingen worden commando's, met id's en volgordesleutels |
| Datumtaal | `core/dateNl.js` | In drie lagen: herhalingen (eigen regels, ook de n-de weekdag van de maand, dagdelen, "elk jaar op 5 december"); eenmalige datums via de meegebundelde herkenner; Nederlandse aanvullingen daarop (dag met maandnaam, begin/midden/eind van een maand, feestdagen met voorzetsel, Pasen berekend, "deze week", IJ-hoofdletter). Zie README, hoofdstuk "Nederlands" |
| Meldingen | `core/messages.js` | Foutcodes van de server worden begrijpelijk Nederlands, zonder technische veldnamen |
| Snel toevoegen | `core/quickadd.js` | `#project`, `/sectie`, `@label`, `p1` tot `p4` of `!!1` tot `!!4`, `{deadline}`, datum in gewone taal; `~` zet de herkenning uit |
| Overzichten | `core/selectors.js` | Project (secties, subtaken), Vandaag (te laat apart), Binnenkort |
| Offline | `sw.js` | Bewaart alle bestanden van de app en vult de bewaarde kopie vanzelf aan als die gewist is |

**Optimistisch rekenen.** De weergave is altijd *bevestigde toestand plus wachtrij*. Na elk sync-antwoord wordt de bevestigde toestand vervangen en de nog niet bevestigde wachtrij er opnieuw op toegepast. Een wijziging van een ander apparaat overschrijft dus nooit een wijziging die nog moet worden verstuurd.

**Geweigerde wijzigingen.** Weigert de server een commando (bijvoorbeeld omdat de taak intussen elders is verwijderd), dan verdwijnt het uit de wachtrij, valt de weergave terug op de werkelijke toestand en toont de app de reden.

## 9. Beveiliging

- Wachtwoorden met **scrypt** (N=2^15, r=8, eigen salt; de kosten staan in de hash, zodat ze later omhoog kunnen). Een onbekende gebruikersnaam kost evenveel rekentijd als een bekende.
- **Sessies:** per apparaat een willekeurig token van 256 bits (`tky_…`); de database bewaart alleen de SHA-256 ervan, dus een gelekte database of back-up geeft geen werkende sessies. Uitloggen, een nieuw wachtwoord, blokkeren en intrekken werken direct, ook voor open live-verbindingen.
- **Inlogpogingen beperkt:** 8 mislukkingen per gebruikersnaam en 40 per adres per kwartier. Achter een eigen proxy telt met `TRUST_PROXY=1` het adres uit `X-Forwarded-For` (de laatste waarde).
- Elke toegangsregel uit hoofdstuk 4 en 5 is getest, en gecontroleerd met opzettelijk gebroken code (elke gebroken regel laat een test falen).
- Luistert standaard op `127.0.0.1`. Zet er voor gebruik buiten je netwerk een reverse proxy met **TLS** voor; wachtwoord en sessietoken reizen anders in de open lucht.
- **Voor een telefoon heb je HTTPS nodig.** Browsers staan service workers (offline gebruik) en installeren als app alleen toe op een beveiligde herkomst; alleen `localhost` is daarop een uitzondering.
- Het sessietoken staat nooit in een URL, dus ook niet in toegangslogs van een proxy.
- De web-app wordt met een strikte Content-Security-Policy geleverd (alleen eigen bronnen, geen inline scripts of stijlen, niet in een frame te laden). Bestanden komen alleen uit twee vaste mappen; padtraversal, verborgen bestanden en Windows-apparaatnamen worden geweigerd.
- Body maximaal 1 MiB, verzoektimeout 30 s, alle SQL gebruikt gebonden parameters.
- Back-up: `node server/backup.ts <doel.db>` maakt een consistente kopie terwijl de server draait. Een kopie bevat alle gegevens van alle gebruikers en de wachtwoord-hashes: bewaar hem net zo zorgvuldig als de database.

## 10. Nog niet gebouwd

| Onderdeel | Opmerking |
|---|---|
| Android-app (APK) | In ontwikkeling: een eigen Kotlin-app die de web-app van je server toont en herinneringen als lokale alarmen op het toestel inplant (zonder Google-diensten). Tot die er is werkt de PWA op Android ("Toevoegen aan startscherm") |
| Herhalingen als gesproken of getypte zin in het bewerkvenster | Het datumveld leest ze al ("elke ma en do"); een kiezer met knoppen ontbreekt |
| Herkennen van een teruggezette database | Het token is nu alleen een versienummer. Een `epoch` (willekeurige waarde, per database) in het token zou een teruggezette of vervangen database altijd een volledige sync laten afdwingen, ook als het versienummer toevallig weer voorbij de stand van een apparaat is gegroeid |
| Filtertaal | Evaluator voor `filter.query` (start: `today`, `overdue`, `p1`–`p4`, `@label`, `#project`, `&`, `\|`, `!`, haakjes) |
| Vandaag-volgorde en weergave-opties | Aparte entiteiten, vergelijkbaar met `day_orders` en `view_options` uit het onderzoek |
| Herinneringen: aanmaken in de app én afleveren | De server kan herinneringen opslaan en synchroniseren (`reminder_*`, relatief of absoluut), maar de app heeft er geen scherm voor en niets verstuurt ze. Afleveren vraagt een planner op de server (hij kent alle herinneringen en due-datums), een tijdzone-instelling (`due` is zwevend, zonder tijdzone), onthouden wat al verstuurd is, en een kanaal naar de telefoon: bijvoorbeeld ntfy (eenvoudig, werkt met de app dicht), Web Push (vereist HTTPS en een eigen implementatie van VAPID en berichtversleuteling) of een Android-schil met exacte alarmen |
| Opmerkingen, favorieten, archiveren, duur, bord- en kalenderweergave | Staan als velden of entiteiten in het datamodel en worden gesynchroniseerd; de app heeft er geen scherm voor |
| De volgorde van taken wijzigen (slepen), zoeken, labels beheren | Ontbreken in de app; `order_key` (de volgordesleutel) en de commando's voor labels zijn er wel |
| Bijlagen, activiteitenlog, voltooide taken met paginering | Voltooide taken blijven nu in `tasks` met `checked: true` |
| Persoonlijke projectvoorkeuren in gedeelde projecten | Volgorde in de zijbalk, favoriet en ingeklapt horen nu bij het project en gelden dus voor alle leden |
| Eigenaarschap overdragen, uitnodigen via link of e-mail | Delen gaat nu op gebruikersnaam; een eigenaar kan een project alleen verwijderen, niet overdragen |
