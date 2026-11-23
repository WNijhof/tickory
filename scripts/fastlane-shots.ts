// Zet de telefoonschermen van de website (website/assets/shots/telefoon-*.webp, licht) om naar PNG voor de Fastlane-map van de
// Android-app (fastlane/metadata/android/<taal>/images/phoneScreenshots/), die F-Droid en IzzyOnDroid lezen. Engels uit shots/,
// Nederlands uit shots/nl/. Gebruikt headless Edge (niets in beeld): het WebP-bestand op een canvas, terug als PNG.
//
//   node scripts/fastlane-shots.ts
//
// Draai het opnieuw na nieuwe schermafbeeldingen (scripts/site-shots.ts).

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SHOTS = join(ROOT, 'website', 'assets', 'shots');
const ORDER = ['vandaag', 'project', 'bord', 'kalender', 'zoeken', 'productiviteit', 'menu'];
const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', '/usr/bin/microsoft-edge', '/usr/bin/chromium', '/usr/bin/google-chrome']
  .find((p) => existsSync(p));
if (!EDGE) throw new Error('geen Edge of Chromium gevonden');

/** Een WebP-bestand als PNG, via een pagina in headless Edge die het op een canvas tekent. */
async function toPng(webp: string): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), 'tickory-png-'));
  try {
    const data = readFileSync(webp).toString('base64');
    const page = join(dir, 'p.html');
    writeFileSync(page, `<!doctype html><body><script>
      const img = new Image();
      img.onload = () => { const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0); document.title = 'klaar'; document.body.textContent = c.toDataURL('image/png'); };
      img.src = 'data:image/webp;base64,${data}';
    </script></body>`);
    const out = await new Promise<string>((resolve, reject) => {
      const p = spawn(EDGE!, ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${join(dir, 'profiel')}`, '--virtual-time-budget=5000', '--dump-dom', `file:///${page.replace(/\\/g, '/')}`], { stdio: ['ignore', 'pipe', 'ignore'] });
      let text = '';
      p.stdout.on('data', (c) => { text += c; });
      p.on('error', reject);
      p.on('close', () => resolve(text));
    });
    const m = /data:image\/png;base64,([A-Za-z0-9+/=]+)/.exec(out);
    if (!m) throw new Error(`omzetten mislukt: ${webp}`);
    return Buffer.from(m[1], 'base64');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const [lang, folder] of [['en-US', ''], ['nl-NL', 'nl/']] as const) {
  const target = join(ROOT, 'fastlane', 'metadata', 'android', lang, 'images', 'phoneScreenshots');
  mkdirSync(target, { recursive: true });
  for (const [i, name] of ORDER.entries()) {
    const png = await toPng(join(SHOTS, `${folder}telefoon-${name}-light.webp`));
    writeFileSync(join(target, `${i + 1}_${name}.png`), png);
    console.log(`${lang}/${i + 1}_${name}.png: ${Math.round(png.length / 1024)} kB`);
  }
}
