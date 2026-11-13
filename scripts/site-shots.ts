// Maakt de schermafbeeldingen voor de website en de README, en het voorbeeldplaatje voor GitHub (social preview).
// Het script bouwt de demo, opent die in een browser zonder venster en legt vaste schermen vast: computer en telefoon,
// licht en donker, in het Nederlands en in het Engels (de app is tweetalig). De klok en de tijdzone van de pagina staan
// vast (dinsdag 17 november 2026, 9:41, Europe/Amsterdam), zodat de beelden bij elke run hetzelfde zijn.
//
// Gebruik: node scripts/site-shots.ts [--preview]
//   Schrijft website/assets/shots/<naam>-light.webp en -dark.webp (Engels: shots/en/<naam>-…), shots.json (de afmetingen)
//   en website/assets/social-preview.png. Met --preview komen er ook PNG-kopieën in .site-work/shots/preview/ om na te kijken.
// Poorten: SHOTS_PORT (8797) en SHOTS_CDP_PORT (9347).

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSite } from './build-site.ts';
import { startSiteServer } from './serve-site.ts';
import { js, launchBrowser, sleep } from './site-browser.ts';
import nl from '../client/i18n/nl.js';
import en from '../client/i18n/en.js';

type Lang = 'nl' | 'en';
const WORDS: Record<Lang, Record<string, any>> = { nl, en };

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const WORK = `${ROOT}.site-work/shots`;
const OUT = `${ROOT}website/assets/shots`;
const PREVIEW = process.argv.includes('--preview');
const PORT = Number(process.env.SHOTS_PORT ?? 8797);
const CDP_PORT = Number(process.env.SHOTS_CDP_PORT ?? 9347);

/** De dag waarop de schermafbeeldingen "gemaakt" zijn: dinsdag 17 november 2026, 9:41 (plaatselijke tijd). */
const FIXED_NOW = [2026, 10, 17, 9, 41];
const FIXED_ZONE = 'Europe/Amsterdam';
const FIXED_DATE = `(() => {
  const RealDate = Date;
  const offset = new RealDate(${FIXED_NOW.join(', ')}).getTime() - RealDate.now();
  class FixedDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(RealDate.now() + offset); else super(...args); }
    static now() { return RealDate.now() + offset; }
  }
  globalThis.Date = FixedDate;
})();`;

const DESKTOP = { width: 1120, height: 720, scale: 2, mobile: false };
/** Voor vensters (taak bewerken, instellingen): hoog genoeg dat er niets wordt afgesneden. */
const TALL = { width: 1120, height: 1000, scale: 2, mobile: false };
/** Voor het taakvenster: zo hoog dat het grote venster met al zijn onderdelen in beeld past. */
const HIGH = { width: 1120, height: 1500, scale: 2, mobile: false };
const PHONE = { width: 390, height: 780, scale: 2, mobile: true };
type View = typeof DESKTOP;

rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
mkdirSync(`${WORK}/preview`, { recursive: true });
mkdirSync(`${OUT}/en`, { recursive: true });
buildSite({ out: `${WORK}/site`, pages: false, quiet: true });
const site = await startSiteServer({ root: `${WORK}/site`, port: PORT });
const browser = await launchBrowser({ workDir: WORK, cdpPort: CDP_PORT, width: DESKTOP.width, height: DESKTOP.height });
const { evaluate, waitFor } = browser;

// ---------- handelingen in de app ----------

let lang: Lang = 'nl';
/** De tekst van de app in de taal waarin we nu vastleggen (zo staan er hier geen losse Nederlandse of Engelse teksten). */
const T = (key: string, params: Record<string, string> = {}): string => {
  const value = WORDS[lang][key];
  if (typeof value !== 'string') throw new Error(`geen tekst voor ${key} in ${lang}`);
  return value.replace(/\{(\w+)\}/g, (whole, name) => params[name] ?? whole);
};

const nav = (label: string) =>
  evaluate(`(() => { const el = [...document.querySelectorAll('.nav-item')].find((b) => b.querySelector('.nav-label')?.textContent === ${js(label)}); if (!el) throw new Error('geen menu-item: ' + ${js(label)}); el.click(); })()`);
const clickText = (text: string, root = 'document') =>
  evaluate(`(() => { const el = [...${root}.querySelectorAll('button')].find((b) => b.textContent.trim() === ${js(text)}); if (!el) throw new Error('geen knop: ' + ${js(text)}); el.click(); })()`);
const typeInto = (selector: string, text: string) =>
  evaluate(`(() => { const el = document.querySelector(${js(selector)}); if (!el) throw new Error('niet gevonden: ' + ${js(selector)}); el.focus(); el.value = ${js(text)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const openTask = (title: string) =>
  evaluate(`(() => { const li = [...document.querySelectorAll('.task')].find((l) => l.querySelector('.task-title').textContent === ${js(title)}); if (!li) throw new Error('geen taak: ' + ${js(title)}); li.querySelector('.task-body').click(); })()`);
const title = (text: string) => waitFor(`document.getElementById('view-title').textContent === ${js(text)}`, `scherm ${text}`);
const settle = async () => {
  // twee beeldverversingen: de app tekent na een wijziging pas bij de volgende verversing
  await evaluate(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`);
  await sleep(120);
};
const closeDialogs = async () => {
  await evaluate(`document.activeElement?.blur()`);
  await clickText(T('common.close'), `[...document.querySelectorAll('dialog[open]')].at(-1)`).catch(() => {});
};

/** Opent de demo opnieuw (verse voorbeeldgegevens), zonder de demo-balk: de beelden tonen de app zoals ze is. */
async function fresh(view: View) {
  await browser.viewport(view.width, view.height, { scale: view.scale, mobile: view.mobile });
  await browser.colorScheme('light');
  await browser.goto(`${site.url}demo/?lang=${lang}`);
  await waitFor(`document.body.classList.contains('ready') && document.getElementById('sync-status').textContent === ${js(T('sync.upToDate'))} && document.querySelectorAll('.nav-item').length > 4`, 'demo gestart');
  await evaluate(`(() => { document.getElementById('demo-bar').remove(); document.documentElement.style.setProperty('--demo-bar', '0px'); })()`);
  await settle();
}

const sizes: Record<string, { width: number; height: number }> = {};
type Clip = { x: number; y: number; width: number; height: number };

/** Het kader om een element (in CSS-punten), met wat ruimte eromheen. */
const around = (selector: string, pad = 0) =>
  evaluate<Clip>(`(() => { const r = document.querySelector(${js(selector)}).getBoundingClientRect(); return { x: Math.max(0, Math.floor(r.x) - ${pad}), y: Math.max(0, Math.floor(r.y) - ${pad}), width: Math.ceil(r.width) + ${2 * pad}, height: Math.ceil(r.height) + ${2 * pad} }; })()`);

/** Legt het scherm vast in licht en donker. `clip` (in CSS-punten) beperkt het beeld tot een deel van het scherm. */
async function capture(name: string, view: View, clip?: Clip) {
  const key = `${lang === 'en' ? 'en/' : ''}${name}`;
  for (const theme of ['light', 'dark'] as const) {
    await browser.colorScheme(theme);
    await settle();
    const region = clip ?? { x: 0, y: 0, width: view.width, height: view.height };
    writeFileSync(`${OUT}/${key}-${theme}.webp`, await browser.screenshot({ format: 'webp', quality: 88, clip: region }));
    if (PREVIEW) writeFileSync(`${WORK}/preview/${key.replace('/', '-')}-${theme}.png`, await browser.screenshot({ format: 'png', clip: region }));
    sizes[key] = { width: Math.round(region.width * view.scale), height: Math.round(region.height * view.scale) };
  }
  await browser.colorScheme('light');
  console.log(`✔ ${key}`);
}

async function shootAll() {
  const projectName = 'Huishouden'; // de voorbeeldgegevens zijn Nederlands, ook in de Engelse interface

  // ---- computer ----
  await fresh(DESKTOP);
  await title(T('nav.today'));
  await capture('vandaag', DESKTOP);

  await nav(T('nav.upcoming'));
  await title(T('nav.upcoming'));
  await capture('binnenkort', DESKTOP);

  await nav(projectName);
  await title(projectName);
  await capture('project', DESKTOP);

  // snel toevoegen: de regel is getypt, het voorbeeld eronder laat zien wat er herkend is (ook de herinnering)
  await typeInto('#quick-input', 'Loodgieter bellen morgen om 9 uur /Klusjes @bellen p1 !1u');
  await waitFor(`document.querySelectorAll('#quick-preview .chip').length >= 6`, 'voorbeeld onder het invoerveld');
  await settle();
  // alleen het bovenste stuk van het scherm: van de titel tot en met de eerste taak
  const main = await evaluate<{ x: number; width: number; bottom: number }>(`(() => { const r = document.querySelector('.main').getBoundingClientRect(); return { x: Math.round(r.x), width: Math.round(r.width), bottom: Math.round(document.querySelector('.task').getBoundingClientRect().bottom) + 14 }; })()`);
  await capture('snel-toevoegen', DESKTOP, { x: main.x, y: 0, width: main.width, height: main.bottom });
  await typeInto('#quick-input', '');

  // vensters op een hoger scherm, zodat het hele venster in beeld past
  await browser.viewport(HIGH.width, HIGH.height, { scale: HIGH.scale, mobile: false });
  await openTask('Boodschappen doen');
  await waitFor(`document.querySelector('#task-dialog[open]')`, 'bewerkvenster');
  await evaluate(`document.activeElement?.blur()`);
  await evaluate(`(() => { const d = document.querySelector('#task-dialog'); d.style.height = '960px'; d.style.maxHeight = 'none'; })()`); // zonder schuiven: het hele venster in beeld
  await settle();
  await capture('taak-bewerken', HIGH, await around('#task-dialog', 24));
  await clickText(T('common.cancel'), `document.querySelector('#task-dialog')`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'bewerkvenster gesloten');

  // het venster "Taak toevoegen": de knop bovenaan de zijbalk
  await evaluate(`document.querySelector('.sidebar-add').click()`);
  await waitFor(`document.querySelector('dialog[open] .quick-big')`, 'venster Taak toevoegen');
  await typeInto('dialog[open] .quick-big', 'Loodgieter bellen morgen om 9 uur /Klusjes @bellen p1 !1u');
  await typeInto('dialog[open] textarea', lang === 'nl' ? 'Het lekkende kraantje in de keuken.' : 'The leaking tap in the kitchen.');
  await waitFor(`document.querySelectorAll('dialog[open] .chips .chip').length >= 6`, 'voorbeeld in het venster');
  await evaluate(`document.activeElement?.blur()`);
  await capture('taak-toevoegen', TALL, await around('dialog[open]', 24));
  await clickText(T('common.cancel'), `document.querySelector('dialog[open]')`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'venster gesloten');

  // het projectmenu en het venster om een project te bewerken (naam, kleur, favoriet)
  await clickText(T('project.menu'));
  await waitFor(`document.querySelector('dialog[open] .menu')`, 'projectmenu');
  await capture('projectmenu', TALL, await around('dialog[open]', 24));
  await clickText(T('project.editMenu'), `document.querySelector('dialog[open]')`);
  await waitFor(`document.querySelector('dialog[open] input[name="project-color"]')`, 'projectvenster');
  await evaluate(`document.activeElement?.blur()`);
  await capture('project-bewerken', TALL, await around('dialog[open]', 24));
  await clickText(T('common.cancel'), `document.querySelector('dialog[open]')`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'projectvenster gesloten');

  // de sneltoetsen (de knop met het toetsenbord onderaan de zijbalk)
  await evaluate(`document.querySelector('.sidebar-footer .icon-button').click()`);
  await waitFor(`document.querySelector('dialog[open] .shortcuts')`, 'overzicht van sneltoetsen');
  await evaluate(`document.activeElement?.blur()`);
  await capture('sneltoetsen', TALL, await around('dialog[open]', 24));
  await clickText(T('common.close'), `document.querySelector('dialog[open]')`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'venster gesloten');

  await nav('Inbox');
  await title('Inbox');
  await openTask('Tandarts bellen voor controle');
  await waitFor(`document.querySelectorAll('#task-dialog .device').length === 3`, 'herinneringen in het taakvenster');
  await evaluate(`document.activeElement?.blur()`);
  await evaluate(`(() => { const d = document.querySelector('#task-dialog'); d.style.height = '960px'; d.style.maxHeight = 'none'; })()`);
  await settle();
  await capture('herinneringen', HIGH, await around('#task-dialog section[aria-label]', 8));
  await clickText(T('common.cancel'), `document.querySelector('#task-dialog')`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'bewerkvenster gesloten');

  await nav(projectName);
  await title(projectName);
  await clickText(T('project.shared'));
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent === ${js(T('share.title', { name: projectName }))}`, 'deelvenster');
  await evaluate(`document.activeElement?.blur()`);
  await capture('delen', TALL, await around('dialog[open]', 24));
  await clickText(T('common.close'), `document.querySelector('dialog[open]')`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'deelvenster gesloten');

  await nav('Anna');
  await waitFor(`document.querySelector('dialog[open] .menu')`, 'instellingen');
  await capture('instellingen', TALL, await around('dialog[open]', 24));
  await clickText(T('settings.notifications'));
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent === ${js(T('notify.title'))} && document.querySelector('dialog[open] details.section:nth-of-type(3) .section-form')`, 'scherm herinneringen en meldingen');
  await evaluate(`document.activeElement?.blur()`);
  await sleep(300);
  // alleen de automatische herinnering en de tijdzone: het derde deel (meldingen op dit apparaat) ziet er in de demo anders uit dan op een eigen server
  await evaluate(`document.querySelector('dialog[open] details.section:nth-of-type(3)').hidden = true`);
  await capture('meldingen', TALL, await around('dialog[open]', 24));
  await closeDialogs();
  await waitFor(`!document.querySelector('dialog[open]')`, 'scherm gesloten');

  await nav('Anna');
  await waitFor(`document.querySelector('dialog[open] .menu')`, 'instellingen');
  await clickText(T('settings.account'));
  await waitFor(`document.querySelectorAll('dialog[open] .device').length >= 2`, 'apparatenlijst');
  await evaluate(`document.activeElement?.blur()`);
  await capture('account', TALL, await around('dialog[open]', 24));
  await clickText(T('admin.title'));
  await waitFor(`document.querySelectorAll('dialog[open] .device').length >= 5`, 'gebruikerslijst');
  await evaluate(`document.activeElement?.blur()`);
  await capture('gebruikersbeheer', TALL, await around('dialog[open]', 24));

  // ---- telefoon ----
  await fresh(PHONE);
  await title(T('nav.today'));
  await capture('telefoon-vandaag', PHONE);
  await nav(projectName);
  await title(projectName);
  await capture('telefoon-project', PHONE);
  await evaluate(`document.getElementById('menu-button').click()`);
  await sleep(350); // het menu schuift in beeld
  await capture('telefoon-menu', PHONE);
}

let failed: unknown = null;
try {
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: FIXED_DATE });
  await browser.send('Emulation.setTimezoneOverride', { timezoneId: FIXED_ZONE });

  for (const l of ['nl', 'en'] as const) {
    lang = l;
    console.log(`\n--- ${l === 'nl' ? 'Nederlands' : 'English'} ---`);
    await shootAll();
  }

  writeFileSync(`${OUT}/shots.json`, `${JSON.stringify(sizes, null, 2)}\n`);

  // ---- voorbeeldplaatje voor GitHub (1280 x 640), met de Engelse interface ----
  // het beeldmerk in omgekeerde kleuren (wit vlak, groen vinkje), zodat het loskomt van de groene achtergrond
  const logo = readFileSync(`${ROOT}website/assets/logo.svg`, 'utf8')
    .replace(/<svg /, '<svg width="132" height="132" ')
    .replaceAll('fill="#0f766e"', 'fill="#ffffff"').replace('stroke="#fff"', 'stroke="#0f766e"').replace('stroke="#5eead4"', 'stroke="#2dd4bf"');
  const shot = readFileSync(`${OUT}/en/project-light.webp`).toString('base64');
  const phone = readFileSync(`${OUT}/en/telefoon-vandaag-light.webp`).toString('base64');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; margin: 0; }
    body { width: 1280px; height: 640px; overflow: hidden; background: linear-gradient(115deg, #0a524c 0%, #0f766e 62%, #128679 100%); color: #fff; font-family: "Segoe UI", system-ui, -apple-system, Roboto, sans-serif; position: relative; }
    .text { position: absolute; left: 72px; top: 96px; width: 520px; }
    .brand { display: flex; align-items: center; gap: 28px; }
    .brand svg { border-radius: 30px; box-shadow: 0 14px 34px rgb(0 0 0 / 28%); }
    h1 { font-size: 104px; font-weight: 700; letter-spacing: -3px; line-height: 1; }
    p { margin-top: 44px; font-size: 40px; line-height: 1.25; font-weight: 600; }
    small { display: block; margin-top: 26px; font-size: 27px; line-height: 1.35; color: #ccfbf1; font-weight: 400; }
    .wide { position: absolute; left: 660px; top: 84px; width: 900px; border-radius: 18px; box-shadow: 0 30px 80px rgb(0 0 0 / 35%); }
    .phone { position: absolute; left: 1010px; top: 196px; width: 236px; border-radius: 26px; border: 6px solid #0b3f3b; box-shadow: 0 24px 60px rgb(0 0 0 / 45%); }
  </style></head><body>
    <div class="text">
      <div class="brand">${logo}<h1>Tickory</h1></div>
      <p>The to-do list you host yourself.</p>
      <small>For you, your family or a small team. Works offline. Open source.</small>
    </div>
    <img class="wide" src="data:image/webp;base64,${shot}" alt="">
    <img class="phone" src="data:image/webp;base64,${phone}" alt="">
  </body></html>`;
  await browser.viewport(1280, 640, { scale: 1, mobile: false });
  await browser.goto('about:blank');
  const frame = (await browser.send('Page.getFrameTree')).frameTree.frame.id;
  await browser.send('Page.setDocumentContent', { frameId: frame, html });
  await waitFor(`[...document.images].length === 2 && [...document.images].every((i) => i.complete && i.naturalWidth > 0)`, 'afbeeldingen van het voorbeeldplaatje geladen');
  await settle();
  writeFileSync(`${ROOT}website/assets/social-preview.png`, await browser.screenshot({ format: 'png', clip: { x: 0, y: 0, width: 1280, height: 640 } }));
  console.log('✔ social-preview.png (1280 x 640)');

  if (browser.errors.length > 0) throw new Error(`fouten in de console van de browser:\n${browser.errors.join('\n')}`);
} catch (err) {
  failed = err;
} finally {
  await browser.close();
  await site.close();
}

if (failed) {
  console.error('\n✖ Schermafbeeldingen maken mislukt:\n', failed);
  process.exit(1);
}
console.log(`\nSchermafbeeldingen staan in website/assets/shots/ (${Object.keys(sizes).length} schermen, licht en donker, Nederlands en Engels).`);
