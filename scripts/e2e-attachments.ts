// Bijlagen in een echte browser: een bestand kiezen zoals een gebruiker dat doet (via het DevTools-protocol, dus een echt bestand van
// schijf in het echte bestandsveld), uploaden, voorbeeld, openen en opslaan, offline kiezen en later uploaden, toegang van een ander,
// verwijderen. Wordt aangeroepen vanuit scripts/e2e.ts (stap 8g2); de hulpfuncties van die test komen binnen via `c`.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

/** Een echte, kleine PNG (een verloop van kleur) die de browser kan tekenen. */
export function makePng(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let x = n; for (let k = 0; k < 8; k++) x = x & 1 ? 0xedb88320 ^ (x >>> 1) : x >>> 1; return x >>> 0; });
  const crc = (buf: Buffer) => { let x = 0xffffffff; for (const b of buf) x = crcTable[(x ^ b) & 0xff] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) raw.set([Math.round((x / width) * 255), Math.round((y / height) * 255), 128], y * (width * 3 + 1) + 1 + x * 3);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export async function attachmentScenario(c: any): Promise<void> {
  const { send, evaluate, waitFor, sleep, js, shot, step, serverState, startServer, stopServer, workDir, BASE, bobToken, strangerToken, aliceToken, openTask, click, clickText, noDialog, SYNCED, attachments } = c;
  const filesDir = `${workDir}bestanden/`;
  mkdirSync(filesDir, { recursive: true });
  const png = makePng(120, 80);
  const files = {
    png: `${filesDir}foto van de keuken.png`,
    pdf: `${filesDir}Rekening café.pdf`,
    txt: `${filesDir}notitie.txt`,
    svg: `${filesDir}plaatje.svg`,
    big: `${filesDir}te groot.bin`,
    empty: `${filesDir}leeg.txt`,
  };
  writeFileSync(files.png, png);
  writeFileSync(files.pdf, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200, 0x20)]));
  writeFileSync(files.txt, 'Dit is een notitie.\n');
  writeFileSync(files.svg, '<svg xmlns="http://www.w3.org/2000/svg"><script>window.__svgpwn=1</script></svg>');
  writeFileSync(files.big, Buffer.alloc(attachments.maxUploadBytes + 1, 1));
  writeFileSync(files.empty, '');

  const dlg = '#task-dialog';
  const names = () => evaluate<string[]>(`[...document.querySelectorAll('${dlg} .attachment .attachment-name, ${dlg} .attachment .attachment-name-plain')].map((e) => e.textContent)`);
  const serverAttachments = () => (serverState().attachments as any[]).filter((a) => !a.is_deleted);
  const choose = async (paths: string[], selector = `${dlg} .attachment-actions input[type=file]:not([capture])`) => {
    const { result } = await send('Runtime.evaluate', { expression: `document.querySelector(${js(selector)})` });
    await send('DOM.enable');
    await send('DOM.setFileInputFiles', { files: paths, objectId: result.objectId });
  };
  const note = () => evaluate<string>(`document.querySelector('${dlg} .attachment-note').textContent`);

  const afwasId = serverState().tasks.find((t: any) => t.content === 'Afwasmachine uitruimen').id;
  await openTask('Afwasmachine uitruimen');
  assert.equal(await evaluate(`document.querySelector('${dlg} .attachments .subheading').textContent`), 'Bijlagen');
  assert.equal(await evaluate(`document.querySelector('${dlg} .attachment-none').textContent`), 'Nog geen bijlagen.');
  assert.equal(await evaluate(`document.querySelector('${dlg} .attachment-actions .button').textContent.trim()`), 'Bestand toevoegen');
  assert.equal(await evaluate(`document.querySelector('${dlg} .attachment-actions input[type=file]').multiple`), true);

  // ---- bestanden kiezen: een afbeelding, een pdf met accent in de naam, een tekstbestand en een svg met een script erin ----
  await choose([files.png, files.pdf, files.txt, files.svg]);
  await waitFor(`document.querySelectorAll('${dlg} .attachment:not(.attachment-pending)').length === 4`, 'vier bijlagen in beeld', 15_000);
  await waitFor(SYNCED, 'gesynchroniseerd');
  const rows = serverAttachments();
  assert.deepEqual(rows.map((a: any) => a.name).sort(), ['Rekening café.pdf', 'foto van de keuken.png', 'notitie.txt', 'plaatje.svg']);
  const byName = (n: string) => rows.find((a: any) => a.name === n);
  assert.equal(byName('foto van de keuken.png').mime, 'image/png');
  assert.equal(byName('foto van de keuken.png').size, png.length);
  assert.equal(byName('Rekening café.pdf').mime, 'application/pdf');
  assert.equal(byName('plaatje.svg').mime, 'image/svg+xml');
  assert.ok(rows.every((a: any) => a.creator_id === c.alice.id && a.task_id === afwasId));
  assert.equal(await evaluate(`document.querySelector('${dlg} .attachments .subheading').textContent`), 'Bijlagen (4)');
  const onDisk = readdirSync(attachments.dir).filter((d: string) => /^[0-9a-f]{2}$/.test(d)).flatMap((d: string) => readdirSync(`${attachments.dir}/${d}`));
  assert.equal(onDisk.length, 4, 'vier bestanden in het datavolume, onder willekeurige namen');
  assert.ok(onDisk.every((f: string) => /^[0-9a-f]{32}$/.test(f)));

  // ---- het voorbeeld: de afbeelding wordt met het token opgehaald en als blob-URL getoond ----
  await waitFor(`document.querySelector('${dlg} .attachment-thumb-img')?.naturalWidth === 120`, 'voorbeeld van de afbeelding', 10_000);
  assert.ok(await evaluate(`document.querySelector('${dlg} .attachment-thumb-img').src.startsWith('blob:')`));
  assert.equal(await evaluate(`document.querySelectorAll('${dlg} .attachment-thumb-img').length`), 1, 'alleen de afbeelding heeft een voorbeeld');
  assert.match(await evaluate(`document.querySelector('${dlg} .attachment .attachment-meta').textContent`), /^\d+ B · Alice · zojuist$|^\d+(,\d)? kB · Alice · zojuist$/);
  await shot('bijlagen');

  // groot bekijken
  const item = (name: string) => `[...document.querySelectorAll('${dlg} .attachment')].find((l) => l.querySelector('.attachment-name')?.textContent === ${js(name)})`;
  await evaluate(`${item('foto van de keuken.png')}.querySelector('.attachment-thumb').click()`);
  await waitFor(`document.querySelector('.attachment-viewer img')?.naturalWidth === 120`, 'afbeelding op volle grootte');
  assert.equal(await evaluate(`document.querySelector('.attachment-viewer h2').textContent`), 'foto van de keuken.png');
  await clickText('Sluiten', `[...document.querySelectorAll('dialog[open]')].at(-1)`);
  await waitFor(`!document.querySelector('.attachment-viewer')`, 'viewer gesloten');

  // ---- opslaan: een echt bestand in de downloadmap; een svg komt nooit in de pagina terecht ----
  const downloads = `${workDir}downloads`;
  mkdirSync(downloads, { recursive: true });
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads.replace(/\//g, '\\') });
  await evaluate(`[...document.querySelectorAll('${dlg} .attachment')].find((l) => l.querySelector('.attachment-name').textContent === 'notitie.txt').querySelector('.attachment-tools .button').click()`);
  await waitFor(`true`, 'download gestart');
  for (let i = 0; i < 50 && !existsSync(`${downloads}/notitie.txt`); i++) await sleep(100);
  assert.equal(readFileSync(`${downloads}/notitie.txt`, 'utf8'), 'Dit is een notitie.\n', 'het opgeslagen bestand is gelijk aan het geüploade');
  // de svg openen = opslaan, nooit tonen
  await evaluate(`[...document.querySelectorAll('${dlg} .attachment')].find((l) => l.querySelector('.attachment-name').textContent === 'plaatje.svg').querySelector('.attachment-name').click()`);
  for (let i = 0; i < 50 && !existsSync(`${downloads}/plaatje.svg`); i++) await sleep(100);
  assert.ok(existsSync(`${downloads}/plaatje.svg`), 'een svg wordt opgeslagen');
  assert.equal(await evaluate(`window.__svgpwn === undefined && !document.querySelector('.attachment-viewer')`), true, 'het script in de svg draait niet en er is geen viewer');

  // ---- een bestand dat te groot is, en een leeg bestand ----
  await choose([files.big, files.empty]);
  await waitFor(`document.querySelector('${dlg} .attachment-note').textContent.includes('te groot')`, 'melding bij een te groot bestand');
  const message = await note();
  assert.match(message, /“te groot\.bin” is te groot en is niet toegevoegd \(maximaal \d+(,\d+)? MB\)\./);
  assert.match(message, /“leeg\.txt” is leeg en is niet toegevoegd\./);
  assert.equal(serverAttachments().length, 4, 'niets extra aangekomen');

  // ---- toegang: een vreemde krijgt niets; Bob (lid van Thuis) en Alice wel ----
  const pngRow = byName('foto van de keuken.png');
  const get = (token: string | null, id: string) => fetch(`${BASE}/api/v1/attachments/${id}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  assert.equal((await get(strangerToken, pngRow.id)).status, 404);
  const asBob = await get(bobToken, pngRow.id);
  assert.equal(asBob.status, 200, 'Bob is lid van Thuis');
  await asBob.arrayBuffer();
  assert.equal((await get(null, pngRow.id)).status, 401);
  const asAlice = await get(aliceToken, pngRow.id);
  assert.equal(asAlice.status, 200);
  assert.deepEqual(Buffer.from(await asAlice.arrayBuffer()), png);
  assert.equal((await get(aliceToken, 'bestaat-niet-12345')).status, 404);

  // ---- de teller in de lijst ----
  await click(`${dlg} .dialog-buttons .button:not(.button-primary):not(.button-danger)`);
  await noDialog();
  await waitFor(`[...document.querySelectorAll('.task')].find((l) => l.querySelector('.task-title').textContent === 'Afwasmachine uitruimen').querySelector('.chip-attachments')?.textContent === '4'`, 'teller van bijlagen in de lijst');
  step('bijlagen: bestanden kiezen (echte bestandskeuze), ze komen in het datavolume onder willekeurige namen, voorbeeld en groot bekijken van een afbeelding, opslaan, een svg wordt nooit getoond, te groot en leeg worden gemeld, een vreemde krijgt niets, teller in de lijst');

  // ---- offline kiezen, de pagina herladen, en later uploaden ----
  await openTask('Afwasmachine uitruimen');
  await stopServer();
  await choose([files.txt]);
  await waitFor(`document.querySelector('${dlg} .attachment-pending')`, 'wachtend bestand in beeld');
  await waitFor(`document.querySelector('${dlg} .attachment-pending .attachment-meta').textContent.includes('Wacht op verbinding')`, 'status wacht op verbinding', 20_000);
  assert.equal(await evaluate(`document.querySelectorAll('${dlg} .attachment-pending .attachment-tools button').length`), 1, 'weghalen kan');
  await shot('bijlage-wachtend');
  await click(`${dlg} .dialog-buttons .button:not(.button-primary):not(.button-danger)`);
  await noDialog();
  await send('Page.reload');
  await waitFor(`document.body.classList.contains('ready')`, 'app gestart (offline)');
  await openTask('Afwasmachine uitruimen');
  await waitFor(`document.querySelector('${dlg} .attachment-pending')`, 'het wachtende bestand overleeft herladen (lokaal bewaard)');
  assert.equal(await evaluate(`document.querySelector('${dlg} .attachment-pending .attachment-name-plain').textContent`), 'notitie.txt');
  await startServer();
  await waitFor(`document.querySelectorAll('${dlg} .attachment:not(.attachment-pending)').length === 5`, 'het wachtende bestand is geüpload zodra de server terug is', 60_000);
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(serverAttachments().length, 5);
  assert.equal(await evaluate(`document.querySelectorAll('${dlg} .attachment-pending').length`), 0);

  // ---- verwijderen: met bevestiging; bestand weg, ruimte terug ----
  const used = () => attachments.used(c.alice.id);
  const usedBefore = used();
  await evaluate(`[...document.querySelectorAll('${dlg} .attachment')].find((l) => l.querySelector('.attachment-name').textContent === 'plaatje.svg').querySelector('[aria-label^="Bijlage plaatje.svg verwijderen"]').click()`);
  await waitFor(`[...document.querySelectorAll('dialog[open] h2')].some((e) => e.textContent === 'Bijlage verwijderen?')`, 'bevestiging');
  await evaluate(`[...document.querySelectorAll('dialog[open]')].at(-1).querySelector('.button-danger').click()`);
  await waitFor(`document.querySelectorAll('${dlg} .attachment').length === 4`, 'bijlage verdwenen uit het venster');
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(serverAttachments().length, 4);
  assert.ok(used() < usedBefore, 'de opslagruimte van Alice is kleiner geworden');
  const svgGone = await get(aliceToken, byName('plaatje.svg').id);
  assert.equal(svgGone.status, 404);
  const remaining = readdirSync(attachments.dir).filter((d: string) => /^[0-9a-f]{2}$/.test(d)).flatMap((d: string) => readdirSync(`${attachments.dir}/${d}`));
  assert.equal(remaining.length, 4, 'ook het bestand zelf is van schijf');
  step('bijlagen offline: kiezen zonder server (status "Wacht op verbinding"), herladen (lokaal bewaard), uploaden zodra de server terug is; verwijderen met bevestiging haalt ook het bestand van schijf');

  await click(`${dlg} .dialog-buttons .button:not(.button-primary):not(.button-danger)`);
  await noDialog();
}
