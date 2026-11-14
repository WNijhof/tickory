# Security

(Nederlands: [zie onderaan](#nederlands).)

## Reporting a vulnerability

Please do **not** open a public issue for a security problem.

Report it privately through GitHub: open the [Security tab](https://github.com/WNijhof/tickory/security) of this repository and choose **Report a vulnerability**. That starts a private conversation with the maintainer. There is no e-mail address for security reports.

A useful report contains:

- which version or commit you looked at, and how Tickory was running (Docker or bare, behind which proxy);
- what an attacker can do, and what they need for it (an account, network access, a link someone has to click);
- the steps to reproduce it, as small as possible.

Do not include real passwords, session tokens or other people's data. Test only against an installation of your own.

This is a small project maintained in spare time, so there is no guaranteed response time and no bug bounty. Reports are read by the maintainer, and a fix is released as a new version.

## Supported versions

Only the latest released version receives fixes. Update before you report, if you can.

## What to know when you run Tickory

- Put HTTPS in front of it (see the guide, "HTTPS"). Without HTTPS the password and the session token travel unencrypted.
- Only set `TRUST_PROXY=1` when there really is a reverse proxy in front.
- A backup contains all tasks of all users, the password hashes and the server's keys for notifications (the VAPID private key and the secret that signs the notification buttons): keep it as carefully as the database. That also goes for the backup an administrator downloads in the app (User management, "Backup"): it asks for the password again (and a code with two-step verification), the download link works once and for one minute, at most five per hour, and every download is logged.
- Two-step verification (TOTP) keeps its secrets encrypted with a key from `secret.key` (next to the database, or `SECRET_KEY_FILE`). That file is deliberately not in the database or in a backup, so a stolen backup does not give away the second factor. Keep your own copy of it, separately from your backups; without it, two-step verification has to be turned off per user after a restore on a new server (`node server/main.ts user reset-2fa <name>`).
- Sessions expire after 90 days without use and 365 days after signing in (`SESSION_IDLE_DAYS`, `SESSION_MAX_DAYS`; 0 turns a limit off). Signing out all other devices is one button under Account.
- Attachments are stored in the data volume (`attachments/` next to the database) and are part of a backup (`node server/backup.ts` copies them next to the database copy). Users upload files, so set `MAX_UPLOAD_MB` and `ATTACHMENT_QUOTA_MB` to what your disk can take, and make sure a reverse proxy allows bodies of that size (nginx: `client_max_body_size`). Files are stored under random names, never served as a page (always a download, `nosniff`, a sandboxing Content-Security-Policy; only png, jpeg, gif, webp and pdf can be shown inline, never svg or html), and only to members of the project. The server does not scan files for viruses.
- After the first start, remove `TODO_ADMIN_PASSWORD` from `.env` and recreate the container, or use `TODO_ADMIN_PASSWORD_FILE`; otherwise the password stays visible in `docker inspect`.
- Signing in with SSO (OpenID Connect, `OIDC_ISSUER` and the other `OIDC_*` settings): Tickory is the OIDC client itself (authorization code flow with PKCE, `state` and `nonce`) and checks the ID token without libraries (signature with a key from the provider's JWKS, never `none` or HMAC; `iss`, `aud`/`azp`, `exp`/`iat`/`nbf`, `nonce`), only over HTTPS, with time-outs and size limits. Accounts are linked by the user (after their password and two-step code), never automatically by e-mail address or name. Only turn on `OIDC_AUTO_CREATE` with a provider you control or together with `OIDC_ALLOWED_GROUPS`: with Google or Microsoft everyone with such an account would get in. Signing in through the provider skips Tickory's own two-step verification (the provider's applies), and blocking someone at the provider does not end their Tickory sessions: block them in Tickory too. With `OIDC_ONLY=1` password sign-in is off; the emergency route is `node server/main.ts user signin-code <name>` on the server.
- The security model (password hashing, sessions, sign-in limits, SSO, Content-Security-Policy) is described in chapter 9 of [SPEC.md](SPEC.md) (in Dutch).

## Nederlands

Open voor een beveiligingsprobleem **geen** openbare melding (issue).

Meld het besloten via GitHub: open het tabblad [Security](https://github.com/WNijhof/tickory/security) van deze repo en kies **Report a vulnerability**. Daarmee begin je een besloten gesprek met de beheerder. Er is geen e-mailadres voor beveiligingsmeldingen.

Vermeld welke versie of commit je bekeek en hoe Tickory draaide, wat een aanvaller kan doen en wat die daarvoor nodig heeft, en de stappen om het na te doen. Stuur geen echte wachtwoorden, sessietokens of gegevens van anderen mee, en test alleen op een eigen installatie.

Dit is een klein project dat in vrije tijd wordt onderhouden: er is geen gegarandeerde reactietijd en geen beloning. De beheerder leest elke melding, en een oplossing komt uit als nieuwe versie. Alleen de laatst uitgebrachte versie krijgt reparaties.

Bij het draaien: een back-up bevat alle taken van alle gebruikers, de wachtwoord-hashes en de sleutels van de server voor meldingen (de VAPID-privésleutel en het geheim waarmee de knoppen in meldingen worden ondertekend). Bewaar hem net zo zorgvuldig als de database; dat geldt ook voor de back-up die een beheerder in de app downloadt (Gebruikersbeheer, "Back-up"). Daarvoor vraagt de app opnieuw het wachtwoord (en een code bij tweestapsverificatie); de downloadlink werkt één keer en een minuut, hooguit vijf keer per uur, en elke download komt in het log. Tweestapsverificatie (TOTP) bewaart de geheimen versleuteld met een sleutel uit `secret.key` (naast de database, of `SECRET_KEY_FILE`); dat bestand zit bewust niet in de database en niet in een back-up, zodat een gestolen back-up de tweede stap niet weggeeft. Bewaar er zelf een kopie van, apart van je back-ups; zonder dat bestand moet tweestapsverificatie na terugzetten op een nieuwe server per gebruiker uit (`node server/main.ts user reset-2fa <naam>`). Sessies verlopen na 90 dagen zonder gebruik en 365 dagen na het inloggen (`SESSION_IDLE_DAYS`, `SESSION_MAX_DAYS`; 0 = uit).

Inloggen met SSO (OpenID Connect, `OIDC_ISSUER` en de andere `OIDC_*`-instellingen): Tickory is zelf de OIDC-client (Authorization Code Flow met PKCE, `state` en `nonce`) en controleert het ID-token zonder bibliotheken (handtekening met een sleutel uit de JWKS van de provider, nooit `none` of HMAC; `iss`, `aud`/`azp`, `exp`/`iat`/`nbf`, `nonce`), alleen via HTTPS, met tijdslimieten en groottegrenzen. Een account koppelt de gebruiker zelf (na wachtwoord en code), nooit vanzelf op e-mailadres of naam. Zet `OIDC_AUTO_CREATE` alleen aan met een provider die je zelf beheert of samen met `OIDC_ALLOWED_GROUPS`: bij Google of Microsoft komt anders iedereen met zo'n account binnen. Wie via de provider inlogt, krijgt de tweestapsverificatie van Tickory niet (die van de provider geldt), en iemand blokkeren bij de provider beëindigt diens sessies in Tickory niet: blokkeer ook in Tickory. Met `OIDC_ONLY=1` staat inloggen met een wachtwoord uit; de noodroute is `node server/main.ts user signin-code <naam>` op de server.

Bijlagen: de bestanden staan in het datavolume (`attachments/` naast de database) en gaan mee in een back-up (`node server/backup.ts`). Gebruikers uploaden bestanden: stel `MAX_UPLOAD_MB` en `ATTACHMENT_QUOTA_MB` in op wat je schijf aankan en laat een reverse proxy zulke bodies toe (nginx: `client_max_body_size`). Bestanden staan onder willekeurige namen, worden nooit als pagina geleverd (altijd een download, `nosniff`, een Content-Security-Policy met `sandbox`; alleen png, jpeg, gif, webp en pdf kunnen inline, nooit svg of html) en alleen aan leden van het project. De server scant bestanden niet op virussen.
