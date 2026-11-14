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
- A backup contains all tasks of all users, the password hashes and the server's keys for notifications (the VAPID private key and the secret that signs the notification buttons): keep it as carefully as the database.
- Attachments are stored in the data volume (`attachments/` next to the database) and are part of a backup (`node server/backup.ts` copies them next to the database copy). Users upload files, so set `MAX_UPLOAD_MB` and `ATTACHMENT_QUOTA_MB` to what your disk can take, and make sure a reverse proxy allows bodies of that size (nginx: `client_max_body_size`). Files are stored under random names, never served as a page (always a download, `nosniff`, a sandboxing Content-Security-Policy; only png, jpeg, gif, webp and pdf can be shown inline, never svg or html), and only to members of the project. The server does not scan files for viruses.
- After the first start, remove `TODO_ADMIN_PASSWORD` from `.env` and recreate the container, or use `TODO_ADMIN_PASSWORD_FILE`; otherwise the password stays visible in `docker inspect`.
- The security model (password hashing, sessions, sign-in limits, Content-Security-Policy) is described in chapter 9 of [SPEC.md](SPEC.md) (in Dutch).

## Nederlands

Open voor een beveiligingsprobleem **geen** openbare melding (issue).

Meld het besloten via GitHub: open het tabblad [Security](https://github.com/WNijhof/tickory/security) van deze repo en kies **Report a vulnerability**. Daarmee begin je een besloten gesprek met de beheerder. Er is geen e-mailadres voor beveiligingsmeldingen.

Vermeld welke versie of commit je bekeek en hoe Tickory draaide, wat een aanvaller kan doen en wat die daarvoor nodig heeft, en de stappen om het na te doen. Stuur geen echte wachtwoorden, sessietokens of gegevens van anderen mee, en test alleen op een eigen installatie.

Dit is een klein project dat in vrije tijd wordt onderhouden: er is geen gegarandeerde reactietijd en geen beloning. De beheerder leest elke melding, en een oplossing komt uit als nieuwe versie. Alleen de laatst uitgebrachte versie krijgt reparaties.

Bijlagen: de bestanden staan in het datavolume (`attachments/` naast de database) en gaan mee in een back-up (`node server/backup.ts`). Gebruikers uploaden bestanden: stel `MAX_UPLOAD_MB` en `ATTACHMENT_QUOTA_MB` in op wat je schijf aankan en laat een reverse proxy zulke bodies toe (nginx: `client_max_body_size`). Bestanden staan onder willekeurige namen, worden nooit als pagina geleverd (altijd een download, `nosniff`, een Content-Security-Policy met `sandbox`; alleen png, jpeg, gif, webp en pdf kunnen inline, nooit svg of html) en alleen aan leden van het project. De server scant bestanden niet op virussen.
