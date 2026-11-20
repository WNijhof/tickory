// Kopieert de gedeelde regels van de server en de web-app (../shared) die de desktop-app gebruikt naar desktop/shared, zodat ze in
// de installer meegaan. Eén bron: niet hier bewerken, maar in eigen-tool/shared. desktop/shared staat niet in git.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, '..', '..', 'shared');
const to = join(here, '..', 'shared');
mkdirSync(to, { recursive: true });
for (const file of ['reminders.js', 'general.js']) copyFileSync(join(from, file), join(to, file));
