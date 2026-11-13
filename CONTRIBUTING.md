# Contributing to Tickory

Thank you for wanting to help. This file is short on purpose: how to test, and the ground rules a change has to fit. (Nederlands: [zie onderaan](#nederlands).)

What gets added, and in which order, is decided by the owner of the repository. For anything larger than a fix, open an issue first and describe what you want to change and why.

## Testing

You need Node 26. There is nothing to install and nothing to build.

```sh
npm test                                        # everything without a browser: protocol, permissions, accounts, client, date language
npm run e2e                                     # the whole app in a real browser (Edge or Chrome, headless)
node scripts/build-site.ts && node scripts/site-check.ts    # the website, the guide and the demo
docker build -t tickory:ci . && node scripts/docker-smoke.ts tickory:ci    # the image (needs Docker)
```

Run `npm test` before every commit; run the browser tests when you touched the client, the website or the demo.

## Ground rules

- **Zero dependencies and no build step.** Server and client run on Node 26 and standard web APIs. No npm packages, no bundler, no CDN. If you think a dependency is unavoidable, make that case in an issue first.
- **Dutch first.** Dutch is the main language of the app: interface, messages and date language have to work well in Dutch, and are tried with real Dutch input first (accents, `ij`, "half 3", holidays). Code comments, commit messages and SPEC.md are in Dutch; the website and the guide are in Dutch and English, with the same structure in both.
- **Tests that can really fail.** A test only counts if breaking the code makes it fail. When you add a rule (who may see or do what, what the parser accepts), add a test for it and check it by breaking the rule on purpose. Do not weaken or remove a test to make a change pass.
- **Be honest about what works.** The README and the guide say what the app cannot do yet. If your change adds or removes a limitation, update the status lists, in both languages.
- **The server is the source of truth, the client works offline.** A change to a command belongs in three places: the server (`server/sync.ts`), the optimistic client (`client/core/reducer.js`) and the differential test that compares the two. The demo backend (`website/demo/backend.js`) follows the server as well; `site-check.ts` compares them.
- **Privacy by default.** No telemetry, no external requests from the app or the website, no secrets in the repository.

## Practical

- Commit messages are in Dutch, one line that says what changed and why it matters, in the style of `git log`.
- Keep a change small and focused; unrelated clean-up goes in a separate commit.
- Security problems are not reported in a public issue; see [SECURITY.md](SECURITY.md).
- By contributing you agree that your contribution is licensed under the [AGPL-3.0](LICENSE), like the rest of the project.

## Nederlands

Fijn dat je wilt helpen. Wat erbij komt en in welke volgorde, bepaalt de eigenaar van de repo; open voor alles wat groter is dan een reparatie eerst een melding (issue) met wat je wilt veranderen en waarom.

**Testen** (vereist Node 26; er is niets te installeren of te bouwen): `npm test` vóór elke commit; `npm run e2e` en `node scripts/build-site.ts && node scripts/site-check.ts` als je aan de client, de website of de demo hebt gezeten; `node scripts/docker-smoke.ts tickory:ci` voor de image.

**Uitgangspunten:**

- **Zero dependencies en geen build-stap.** Geen npm-pakketten, geen bundler, geen CDN.
- **Nederlands als hoofdtaal.** Alles moet met Nederlands goed werken en wordt eerst met echte Nederlandse invoer geprobeerd. Commentaar, commitberichten en SPEC.md zijn Nederlands; de website en de handleiding zijn tweetalig, met dezelfde opbouw.
- **Tests die echt kunnen falen.** Een test telt pas als hij faalt wanneer je de code breekt. Controleer een nieuwe regel door hem opzettelijk te breken. Zwak geen test af om een wijziging te laten slagen.
- **Eerlijk over wat werkt.** Werk de statuslijsten in de README's en de handleiding bij, in beide talen.
- **De server is leidend, de client werkt offline.** Een wijziging aan een commando hoort in `server/sync.ts`, in `client/core/reducer.js` en in de differentiële test; de backend van de demo (`website/demo/backend.js`) volgt de server.
- **Privacy als uitgangspunt.** Geen telemetrie, geen verzoeken naar buiten, geen geheimen in de repo.

Een beveiligingsprobleem meld je niet in een openbare melding; zie [SECURITY.md](SECURITY.md). Wat je bijdraagt, valt net als de rest van het project onder de [AGPL-3.0](LICENSE).
