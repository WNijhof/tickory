// Kopieert de gedeelde regels van de server en de web-app (../shared, en client/core/theme.js en events.js) die de desktop-app gebruikt naar
// desktop/shared, zodat ze in de installer meegaan. Eén bron: niet hier bewerken, maar in het origineel. desktop/shared staat niet in git.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, '..', '..', 'shared');
const to = join(here, '..', 'shared');
mkdirSync(to, { recursive: true });
for (const file of ['reminders.js', 'general.js', 'notes.js', 'notifications.js']) copyFileSync(join(from, file), join(to, file));
// de thema's en accentkleuren van de web-app (Instellingen › Thema): dezelfde lijst voor de titelbalk en de eigen schermen
copyFileSync(join(here, '..', '..', 'client', 'core', 'theme.js'), join(to, 'theme.js'));
// het signaal van de server dat er iets veranderd is (Server-Sent Events via fetch), zoals de web-app het gebruikt
copyFileSync(join(here, '..', '..', 'client', 'core', 'events.js'), join(to, 'events.js'));
