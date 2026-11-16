// Notities in een echte browser, tegen de echte server, zoals Anchor: de regel in de zijbalk, een notitie maken met N, typen met opmaak in
// beeld (Markdown-sneltoetsen, het /-menu, de werkbalk, markeren), checklists die afgevinkte punten naar onderen zetten en inklappen,
// plakken (ook onveilige HTML), ongedaan maken, achtergrond, vastpinnen, labels, de kaarten met "gedaan", zoeken, indeling, selecteren,
// archief en prullenbak, privé voor een ander, en op een telefoon en in het donker. Wordt aangeroepen vanuit scripts/e2e.ts.

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import { createSession } from '../server/users.ts';
import { makeZip } from './zipFixture.ts';

export async function notesScenario(c: any) {
  const { send, evaluate, waitFor, step, shot, sleep, js, SYNCED, db, alice, bob, syncAs, serverState, click, nav, workDir } = c;
  const aliceToken = createSession(db, alice.id, 'Controle notities').token;
  const bobToken = createSession(db, bob.id, 'Bob notities').token;
  let k = 0;
  const as = async (token: string, commands: [string, object][]) => {
    const res = await syncAs(token, 'e2e-notities', commands.map(([type, args]) => ({ type, uuid: `e2e-note-${String(++k).padStart(5, '0')}`, args })));
    assert.equal(res.status, 200);
    const body = await res.json();
    for (const [uuid, s] of Object.entries(body.sync_status)) assert.equal(s, 'ok', `${uuid}: ${JSON.stringify(s)}`);
    return body;
  };
  const notes = (): any[] => (serverState().notes as any[]).filter((n) => !n.is_deleted);
  const synced = () => waitFor(`await ${SYNCED}`, 'gesynchroniseerd', 15_000);
  const startView = await evaluate<string>(`document.getElementById('view-title').textContent`);
  const cards = () => evaluate<string[]>(`[...document.querySelectorAll('.nc .nc-title')].map((e) => e.textContent)`);
  const closeToasts = () => evaluate(`document.querySelectorAll('.toast-close').forEach((b) => b.click())`);
  const key = async (name: string, opts: { text?: string, modifiers?: number, code?: string, vk?: number } = {}) => {
    const vk = opts.vk ?? ({ Enter: 13, Backspace: 8, Escape: 27, Tab: 9, ArrowUp: 38, ArrowDown: 40 } as Record<string, number>)[name] ?? name.toUpperCase().charCodeAt(0);
    await send('Input.dispatchKeyEvent', { type: opts.text ? 'keyDown' : 'rawKeyDown', key: name, code: opts.code ?? name, windowsVirtualKeyCode: vk, text: opts.text, modifiers: opts.modifiers ?? 0 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: opts.code ?? name, windowsVirtualKeyCode: vk, modifiers: opts.modifiers ?? 0 });
  };
  // teken voor teken, zoals iemand typt (de Markdown-sneltoetsen reageren op de spatie direct na "[]" of "-")
  const type = async (text: string) => { for (const ch of text) { if (ch === '\n') await key('Enter', { text: '\r' }); else await send('Input.insertText', { text: ch }); } };
  const blocks = () => evaluate<string[]>(`[...document.querySelectorAll('dialog[open] .ned .nb')].map((b) => b.className.replace(/^nb nb-/, '').replace(' is-checked', '✓').replace(' is-empty', '') + ':' + (b.querySelector('.nb-text')?.textContent ?? ''))`);
  const savedContent = (id: string) => notes().find((n) => n.id === id)?.content;
  const before = notes().length;

  // ---- de regel in de zijbalk en de lege staat ----
  await closeToasts();
  await waitFor(`[...document.querySelectorAll('.nav-item .nav-label')].some((e) => e.textContent === 'Notities')`, 'Notities in de zijbalk');
  await nav('Notities');
  await waitFor(`document.getElementById('view-title').textContent === 'Notities'`, 'het scherm Notities');
  assert.equal(await evaluate(`document.title`), 'Notities · Tickory');
  assert.equal(await evaluate(`document.querySelector('.empty-title')?.textContent`), 'Nog geen notities');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.nav-sub .nav-label')].map((e) => e.textContent)`), ['Archief', 'Prullenbak'], 'onder Notities: archief en prullenbak');
  step('notities: de regel in de zijbalk met archief en prullenbak eronder, en de lege staat');

  // ---- N: een nieuwe notitie, titel, Enter naar de tekst ----
  await evaluate(`document.activeElement?.blur?.()`);
  await key('n', { text: 'n', code: 'KeyN', vk: 78 });
  await waitFor(`document.querySelector('dialog[open] .note-title')`, 'met N opent een nieuwe notitie');
  assert.equal(await evaluate(`document.activeElement?.dataset?.fk`), 'note-title', 'een nieuwe notitie begint bij de titel');
  await synced();
  const made = notes().filter((n) => n.title === '' && !n.content).sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
  assert.ok(made && made.title === '' && made.owner_id === alice.id, 'de nieuwe notitie staat al op de server');
  await type('Boodschappen & ideeën');
  await key('Enter', { text: '\r' });
  assert.equal(await evaluate(`document.activeElement?.dataset?.fk`), 'note-text', 'Enter in de titel gaat naar de tekst');
  // ---- Markdown-sneltoetsen: [] maakt een checklist, Enter gaat door, Enter op een leeg punt stopt ----
  await type('Vandaag halen:\n[] melk\nbrood\nkaas\n\nNa de lijst');
  assert.deepEqual(await blocks(), ['p:Vandaag halen:', 'check:melk', 'check:brood', 'check:kaas', 'p:Na de lijst']);
  await waitFor(`document.querySelector('dialog[open] .note-save-text')?.textContent === 'Opgeslagen'`, 'vanzelf opgeslagen', 5_000);
  await synced();
  assert.equal(savedContent(made.id), 'Vandaag halen:\n- [ ] melk\n- [ ] brood\n- [ ] kaas\nNa de lijst');
  assert.equal(notes().find((n) => n.id === made.id).title, 'Boodschappen & ideeën');
  await shot('notitie-typen');
  step('notities: N maakt een nieuwe notitie, de titel en Enter naar de tekst; "[] " maakt een checklist, Enter gaat door en stopt op een leeg punt; alles vanzelf opgeslagen als Markdown');

  // ---- afvinken: naar onderen, inklappen ----
  await evaluate(`[...document.querySelectorAll('dialog[open] .nb-check')].find((b) => b.textContent === 'melk').querySelector('.nb-box').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))`);
  assert.deepEqual(await blocks(), ['p:Vandaag halen:', 'check:brood', 'check:kaas', 'check✓:melk', 'p:Na de lijst'], 'afgevinkt gaat naar onderen');
  assert.equal(await evaluate(`document.querySelector('dialog[open] .nb-fold-button')?.textContent`), '1 afgevinkt punt');
  await click('dialog[open] .nb-fold-button');
  await evaluate(`document.querySelector('dialog[open] .nb-fold-button').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))`);
  assert.equal(await evaluate(`[...document.querySelectorAll('dialog[open] .nb-check')].find((b) => b.textContent === 'melk').hidden`), true, 'ingeklapt');
  await evaluate(`document.querySelector('dialog[open] .nb-fold-button').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))`);
  await waitFor(`document.querySelector('dialog[open] .note-save-text')?.textContent === 'Opgeslagen'`, 'opgeslagen', 5_000);
  await synced();
  assert.equal(savedContent(made.id), 'Vandaag halen:\n- [ ] brood\n- [ ] kaas\n- [x] melk\nNa de lijst');
  step('notities: een vinkje aanklikken zet het punt onderaan bij "1 afgevinkt punt", in en uit te klappen; zo bewaard');

  // ---- opmaak: werkbalk, sneltoets, markeren, /-menu ----
  const selectText = (text: string) => evaluate(`(() => {
    const walker = document.createTreeWalker(document.querySelector('dialog[open] .ned'), NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) { const i = n.data.indexOf(${js(text)}); if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + ${text.length}); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; } }
    throw new Error('niet gevonden: ' + ${js(text)});
  })()`);
  await selectText('Vandaag');
  await click('dialog[open] [data-tool="bold"]');
  assert.equal(await evaluate(`document.querySelector('dialog[open] .ned strong')?.textContent`), 'Vandaag');
  assert.equal(await evaluate(`document.querySelector('dialog[open] [data-tool="bold"]').getAttribute('aria-pressed')`), 'true');
  await selectText('halen');
  await key('i', { modifiers: 2, code: 'KeyI', vk: 73 });
  assert.equal(await evaluate(`document.querySelector('dialog[open] .ned em')?.textContent`), 'halen', 'Ctrl+I');
  await selectText('Na de lijst');
  await click('dialog[open] [data-tool="highlight"]');
  await click('dialog[open] [data-fk="note-hl:green"]');
  assert.equal(await evaluate(`document.querySelector('dialog[open] .ned mark.hl-green')?.textContent`), 'Na de lijst');
  // het /-menu aan het eind: "/kop" filtert, Enter maakt er een kop van
  await evaluate(`(() => { const t = [...document.querySelectorAll('dialog[open] .nb-text')].at(-1); const r = document.createRange(); r.selectNodeContents(t); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()`);
  await key('Enter', { text: '\r' });
  await type('/');
  await waitFor(`document.querySelector('.nb-slash')`, 'het /-menu');
  await type('kop');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.nb-slash-item')].map((b) => b.textContent)`), ['Kop 1', 'Kop 2', 'Kop 3']);
  await key('ArrowDown');
  await key('Enter', { text: '\r' });
  await waitFor(`!document.querySelector('.nb-slash')`, 'menu dicht');
  await type('Plan');
  assert.equal((await blocks()).at(-1), 'h2:Plan', 'Kop 2 gekozen, de /kop is weg');
  await waitFor(`document.querySelector('dialog[open] .note-save-text')?.textContent === 'Opgeslagen'`, 'opgeslagen', 5_000);
  await synced();
  assert.equal(savedContent(made.id), '**Vandaag** _halen_:\n- [ ] brood\n- [ ] kaas\n- [x] melk\n=={green}Na de lijst==\n## Plan');
  step('notities: vet via de werkbalk, cursief met Ctrl+I, groen markeren, het /-menu filtert ("kop") en maakt Kop 2; zo bewaard als Markdown');

  // ---- plakken: een lijst uit HTML; scripts en javascript:-links blijven weg ----
  await evaluate(`(() => {
    const dt = new DataTransfer();
    dt.setData('text/html', '<ul><li>eieren</li><li>meel<ul><li>volkoren</li></ul></li></ul><p>Zie <a href="javascript:alert(1)">klik</a> en <a href="https://example.org/recept">recept</a><script>window.__geplakt = true<\\/script><img src=x onerror="window.__geplakt = true"></p>');
    dt.setData('text/plain', 'eieren meel');
    document.querySelector('dialog[open] .ned').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  })()`);
  await sleep(200);
  const after = await blocks();
  assert.deepEqual(after.slice(-4), ['bullet:eieren', 'bullet:meel', 'bullet:volkoren', 'p:Zie klik en recept']);
  assert.equal(await evaluate(`[...document.querySelectorAll('dialog[open] .nb-bullet')].find((b) => b.textContent === 'volkoren').dataset.level`), '1', 'de sublijst springt in');
  assert.equal(await evaluate(`window.__geplakt === true`), false, 'niets uit het geplakte is uitgevoerd');
  assert.equal(await evaluate(`document.querySelectorAll('dialog[open] .ned script, dialog[open] .ned img').length`), 0);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('dialog[open] .ned a')].map((a) => a.getAttribute('href'))`), ['https://example.org/recept'], 'alleen het echte webadres is een link');
  // ongedaan maken: het plakken gaat in één keer terug
  await key('z', { modifiers: 2, code: 'KeyZ', vk: 90 });
  assert.equal((await blocks()).at(-1), 'h2:Plan', 'Ctrl+Z haalt het plakken weg');
  await key('z', { modifiers: 2 | 8, code: 'KeyZ', vk: 90 });
  assert.equal((await blocks()).at(-1), 'p:Zie klik en recept', 'Ctrl+Shift+Z zet het terug');
  step('notities: plakken uit HTML geeft een lijst met sublijst; een script, afbeelding of javascript:-link uit het klembord doet niets; Ctrl+Z en Ctrl+Shift+Z');

  // ---- achtergrond, vastpinnen, labels ----
  await click('dialog[open] [data-fk="note:background"]');
  await waitFor(`document.querySelector('dialog[open] .nbg-picker')`, 'de achtergrondkiezer');
  assert.equal(await evaluate(`document.querySelectorAll('dialog[open] .nbg-tile').length`), 19, 'standaard, tien kleuren en acht patronen');
  await click('dialog[open] [data-fk="note-bg:waves"]');
  assert.equal(await evaluate(`document.querySelector('dialog[open] .note-sheet').classList.contains('nbg-waves')`), true);
  await click('dialog[open] [data-fk="note:pin"]');
  await click('dialog[open] [data-fk="note-tag-add"]');
  await waitFor(`document.querySelector('dialog[open] [data-fk="note-label-search"]')`, 'labelkiezer');
  await evaluate(`(() => { const i = document.querySelector('dialog[open] [data-fk="note-label-search"]'); i.value = 'Boodschappen'; i.dispatchEvent(new Event('input')); })()`);
  await click('dialog[open] [data-fk="note-label-create"]');
  await synced();
  const labelId = (serverState().labels as any[]).find((l) => l.name === 'Boodschappen' && l.owner_id === alice.id)?.id;
  assert.ok(labelId, 'het label bestaat');
  await waitFor(`[...document.querySelectorAll('dialog[open] .note-tag')].some((e) => e.textContent.includes('Boodschappen'))`, 'het label als chip', 10_000);
  await key('Escape', { vk: 27 });
  await waitFor(`!document.querySelector('dialog[open] .note-pop')`, 'het labelvenster sluit met Escape (de notitie blijft open)');
  assert.ok(await evaluate(`Boolean(document.querySelector('dialog[open] .note-sheet'))`));
  await shot('notitie-opmaak');
  const row = notes().find((n) => n.id === made.id);
  assert.deepEqual([row.background, row.is_pinned, row.labels], ['waves', true, [labelId]]);
  assert.match(await evaluate<string>(`document.querySelector('dialog[open] .note-meta').textContent`), /^Bewerkt vandaag om \d\d:\d\d · \d+ woorden$/);
  step('notities: achtergrond Golven (19 keuzes), vastpinnen en een nieuw label als chip; Escape sluit eerst het keuzevenster; "Bewerkt vandaag om … · N woorden"');

  // ---- een herinnering: snelle keuze, eigen tijd met herhaling, weghalen ----
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const tomorrow = ymd(new Date(Date.now() + 86_400_000));
  await click('dialog[open] [data-fk="note:reminder"]');
  await waitFor(`document.querySelector('dialog[open] .note-pop-reminder')`, 'het keuzevenster voor een herinnering');
  assert.equal(await evaluate(`document.querySelector('dialog[open] .note-pop-title').textContent`), 'Herinnering');
  assert.ok((await evaluate<string[]>(`[...document.querySelectorAll('dialog[open] .note-pop-reminder .note-menu-label')].map((e) => e.textContent)`)).includes('Morgen'));
  await click('dialog[open] [data-fk="note-reminder:tomorrow"]');
  await waitFor(`!document.querySelector('dialog[open] .note-pop')`, 'het keuzevenster sluit');
  await waitFor(`document.querySelector('dialog[open] [data-fk="note-reminder-chip"]')?.textContent === 'morgen 09:00'`, 'de herinnering als chip onder de titel', 10_000);
  await synced();
  assert.deepEqual([notes().find((n) => n.id === made.id).remind_at, notes().find((n) => n.id === made.id).remind_repeat], [`${tomorrow}T09:00`, null]);
  assert.match(await evaluate<string>(`document.querySelector('dialog[open] [data-fk="note:reminder"]').getAttribute('aria-label')`), /^Herinnering: morgen 09:00$/);
  // eigen datum en tijd, elke week (via de chip)
  await click('dialog[open] [data-fk="note-reminder-chip"]');
  await waitFor(`document.querySelector('dialog[open] [data-fk="note-reminder-when"]')`, 'datum en tijd');
  await evaluate(`(() => { const p = document.querySelector('dialog[open] .note-pop-reminder');
    const w = p.querySelector('[data-fk="note-reminder-when"]'); w.value = ${js(`${tomorrow}T07:45`)}; w.dispatchEvent(new Event('input'));
    const r = p.querySelector('[data-fk="note-reminder-repeat"]'); r.value = 'weekly'; r.dispatchEvent(new Event('change')); })()`);
  await shot('notitie-herinnering');
  await click('dialog[open] [data-fk="note-reminder-save"]');
  await waitFor(`document.querySelector('dialog[open] [data-fk="note-reminder-chip"]')?.textContent === 'morgen 07:45· Elke week'`, 'de chip met de herhaling', 10_000);
  await synced();
  assert.deepEqual([notes().find((n) => n.id === made.id).remind_at, notes().find((n) => n.id === made.id).remind_repeat], [`${tomorrow}T07:45`, 'weekly']);
  // een lege tijd: een melding, niets bewaard
  await click('dialog[open] [data-fk="note-reminder-chip"]');
  await waitFor(`document.querySelector('dialog[open] [data-fk="note-reminder-when"]')`, 'datum en tijd');
  await evaluate(`(() => { const w = document.querySelector('dialog[open] [data-fk="note-reminder-when"]'); w.value = ''; w.dispatchEvent(new Event('input')); })()`);
  await click('dialog[open] [data-fk="note-reminder-save"]');
  assert.equal(await evaluate(`document.querySelector('dialog[open] .note-pop-reminder .hint').textContent`), 'Kies een datum en een tijd.');
  await key('Escape', { vk: 27 });
  await waitFor(`!document.querySelector('dialog[open] .note-pop')`, 'Escape sluit het keuzevenster');
  await closeToasts();
  step('notities: een herinnering met het belletje: "Morgen" (morgen 09:00) als chip onder de titel, een eigen tijd met "Elke week", een lege tijd geeft uitleg; zo op de server');

  // ---- sluiten: de kaart ----
  await click('dialog[open] [data-fk="note-close"]');
  await waitFor(`!document.querySelector('dialog[open]')`, 'venster dicht');
  await synced();
  await waitFor(`document.querySelector('.note-group[data-group="pinned"] .nc')`, 'de kaart bij Vastgepind');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.note-group-title')].map((e) => e.textContent)`), ['Vastgepind1']);
  const card = `document.querySelector('.nc[data-id=${js(made.id)}]')`;
  assert.equal(await evaluate(`${card}.querySelector('.nc-title').textContent`), 'Boodschappen & ideeën');
  assert.equal(await evaluate(`${card}.classList.contains('nbg-waves')`), true);
  assert.equal(await evaluate(`${card}.querySelector('.nc-done').textContent`), '1 gedaan', 'afgevinkte punten als "gedaan"');
  assert.deepEqual(await evaluate(`[...${card}.querySelectorAll('.nc-check li .nc-tx')].map((e) => e.textContent)`), ['brood', 'kaas']);
  assert.equal(await evaluate(`${card}.querySelector('.nc-tag').textContent`), '#Boodschappen');
  assert.equal(await evaluate(`${card}.querySelector('.nc-date').textContent`), 'Vandaag');
  assert.equal(await evaluate(`${card}.querySelectorAll('a').length`), 0, 'op een kaart is een link geen link');
  assert.equal(await evaluate(`${card}.querySelector('.nc-reminder').textContent`), 'morgen 07:45', 'de herinnering op de kaart');
  step('notities: de kaart bij Vastgepind met achtergrond, opmaak, "1 gedaan", het label, de herinnering en "Vandaag"');

  // ---- een melding aangetikt: #note=<id> opent de notitie; daarna de herinnering weghalen ----
  await evaluate(`location.hash = ${js(`#note=${made.id}`)}`);
  await waitFor(`document.querySelector('dialog[open] .note-title')?.value === 'Boodschappen & ideeën'`, '#note= opent de notitie');
  assert.equal(await evaluate(`location.hash`), '', 'het adres weer schoon');
  await click('dialog[open] [data-fk="note-reminder-chip"]');
  await waitFor(`document.querySelector('dialog[open] [data-fk="note-reminder-remove"]')`, 'weghalen');
  await click('dialog[open] [data-fk="note-reminder-remove"]');
  await waitFor(`!document.querySelector('dialog[open] [data-fk="note-reminder-chip"]')`, 'geen chip meer');
  await synced();
  assert.deepEqual([notes().find((n) => n.id === made.id).remind_at, notes().find((n) => n.id === made.id).remind_repeat], [null, null]);
  await click('dialog[open] [data-fk="note-close"]');
  await waitFor(`!document.querySelector('dialog[open]')`, 'venster dicht');
  await closeToasts();
  step('notities: een melding aangetikt (#note=…) opent de notitie, het adres wordt weer schoon; de herinnering weghalen');

  // ---- foto's en geluid: kiezen, plakken, bekijken, afspelen, verwijderen; op de kaart ----
  const filesDir = `${workDir}notitiebestanden/`;
  mkdirSync(filesDir, { recursive: true });
  // een echte (kleine) png en een echte wav van een tiende seconde stilte, en een pdf die niet mag
  // een echte png van 64×48 (een zee boven een strand), zodat de browser hem ook echt kan tonen
  const png = (() => {
    const w = 64, hgt = 48;
    const chunk = (type: string, data: Buffer) => {
      const td = Buffer.concat([Buffer.from(type), data]);
      const out = Buffer.alloc(12 + data.length);
      out.writeUInt32BE(data.length, 0); td.copy(out, 4); out.writeUInt32BE(crc32(td) >>> 0, 8 + data.length);
      return out;
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(hgt, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const raw = Buffer.alloc((w * 3 + 1) * hgt);
    for (let y = 0; y < hgt; y++) {
      for (let x = 0; x < w; x++) {
        const o = y * (w * 3 + 1) + 1 + x * 3;
        const [r, g, b] = y < hgt * 0.6 ? [70, 150, 210] : [236, 210, 150];
        raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
      }
    }
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  })();
  const wav = (() => {
    const samples = 800;
    const b = Buffer.alloc(44 + samples, 128);
    b.write('RIFF', 0); b.writeUInt32LE(36 + samples, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
    b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(samples, 40);
    return b;
  })();
  const media = { png: `${filesDir}strand.png`, wav: `${filesDir}golven.wav`, pdf: `${filesDir}rekening.pdf` };
  writeFileSync(media.png, png);
  writeFileSync(media.wav, wav);
  writeFileSync(media.pdf, '%PDF-1.4\n');
  const noteFiles = () => (serverState().note_files as any[] ?? []).filter((f) => !f.is_deleted && f.note_id === made.id);
  await click(`[data-fk="note:${made.id}"]`);
  await waitFor(`document.querySelector('dialog[open] .note-title')?.value === 'Boodschappen & ideeën'`, 'de notitie open');
  assert.ok(await evaluate(`Boolean(document.querySelector('dialog[open] [data-fk="note-tool:media"]'))`), 'de knop "Afbeelding of geluid toevoegen" in de werkbalk');
  assert.ok(await evaluate(`Boolean(document.querySelector('dialog[open] [data-fk="note-tool:record"]'))`), 'en opnemen (deze browser kan dat)');
  assert.equal(await evaluate(`document.querySelector('dialog[open] .note-files').hidden`), true, 'zonder bestanden geen ruimte');
  {
    const { result } = await send('Runtime.evaluate', { expression: `document.querySelector('dialog[open] [data-fk="note-file-input"]')` });
    await send('DOM.enable');
    await send('DOM.setFileInputFiles', { files: [media.png, media.wav, media.pdf], objectId: result.objectId });
  }
  await waitFor(`document.querySelector('dialog[open] .nf-message')?.textContent.includes('rekening.pdf')`, 'een pdf mag niet');
  assert.equal(await evaluate(`document.querySelector('dialog[open] .nf-message').textContent`), 'rekening.pdf: bij een notitie kan alleen een afbeelding of geluid.');
  await waitFor(`document.querySelectorAll('dialog[open] .nf-pic img').length === 1 && document.querySelectorAll('dialog[open] .nf-sound').length === 1 && !document.querySelector('dialog[open] .nf-pending')`, 'de foto en het geluid in de notitie', 20_000);
  await synced();
  assert.deepEqual(noteFiles().map((f) => [f.name, f.mime]).sort(), [['golven.wav', 'audio/wav'], ['strand.png', 'image/png']]);
  // plakken van een schermafdruk: een foto erbij, niets in de tekst
  const textBefore = await blocks();
  await evaluate(`(() => {
    const bytes = Uint8Array.from(atob(${js(png.toString('base64'))}), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
    document.querySelector('dialog[open] .ned .nb-text')?.focus();
    document.querySelector('dialog[open] .ned').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  })()`);
  await waitFor(`document.querySelectorAll('dialog[open] .nf-pic img').length === 2`, 'de geplakte foto', 20_000);
  assert.deepEqual(await blocks(), textBefore, 'de tekst bleef gelijk');
  // afspelen: een speler met het geluid
  const wavId = noteFiles().find((f) => f.name === 'golven.wav').id;
  await click(`dialog[open] [data-fk="nf-play:${wavId}"]`);
  await waitFor(`document.querySelector('dialog[open] .nf-sound audio')?.src.startsWith('blob:')`, 'een speler');
  await waitFor(`document.querySelector('dialog[open] .nf-sound audio').readyState >= 1`, 'het geluid laadt (juist type, CSP staat blob: toe)', 10_000);
  // bekijken: groot, met vorige en volgende
  const pngId = noteFiles().find((f) => f.name === 'strand.png').id;
  await click(`dialog[open] [data-fk="nf-view:${pngId}"]`);
  await waitFor(`document.querySelector('.dialog-viewer[open] .nf-viewer img')?.src.startsWith('blob:')`, 'de foto groot');
  assert.equal(await evaluate(`document.querySelector('.dialog-viewer[open] .nf-viewer-count').textContent`), '1 / 2');
  assert.match(await evaluate<string>(`[...document.querySelectorAll('dialog[open] .nf-pic-open')].map((b) => b.getAttribute('aria-label')).join('|')`), /^strand\.png bekijken\|Schermafdruk \d\d-\d\d-\d{4} \d\d\.\d\d\.png bekijken$/, 'een geplakte schermafdruk krijgt een naam met datum');
  await click('.dialog-viewer[open] [data-fk="nf-next"]');
  await waitFor(`document.querySelector('.dialog-viewer[open] .nf-viewer-count').textContent === '2 / 2'`, 'volgende');
  await shot('notitie-fotos');
  // de tweede (geplakte) foto verwijderen vanuit het venster, na een vraag
  await click('.dialog-viewer[open] [data-fk="nf-delete"]');
  await waitFor(`[...document.querySelectorAll('dialog[open] .dialog-buttons .button-danger')].some((b) => b.textContent === 'Verwijderen' && !b.closest('.dialog-viewer'))`, 'de vraag');
  await evaluate(`[...document.querySelectorAll('dialog[open] .dialog-buttons .button-danger')].find((b) => b.textContent === 'Verwijderen' && !b.closest('.dialog-viewer')).click()`);
  await waitFor(`!document.querySelector('.dialog-viewer[open]') && document.querySelectorAll('dialog[open] .nf-pic').length === 1`, 'nog één foto');
  await synced();
  assert.equal(noteFiles().length, 2);
  // het /-menu kent "Afbeelding of geluid"
  await evaluate(`document.querySelector('dialog[open] .ned .nb:last-child .nb-text')?.focus()`);
  await evaluate(`(() => { const t = document.querySelector('dialog[open] .ned .nb:last-child .nb-text'); const r = document.createRange(); r.selectNodeContents(t); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()`);
  await key('End', { vk: 35 });
  await key('Enter', { text: '\r' });
  await type('/geluid');
  await waitFor(`[...document.querySelectorAll('dialog[open] .nb-slash-item')].map((b) => b.textContent).join('|') === 'Afbeelding of geluid'`, '/geluid vindt "Afbeelding of geluid"');
  await key('Escape', { vk: 27 });
  await key('Backspace', { vk: 8 }); for (let i = 0; i < 7; i++) await key('Backspace', { vk: 8 });
  await click('dialog[open] [data-fk="note-close"]');
  await waitFor(`!document.querySelector('dialog[open]')`, 'venster dicht');
  await synced();
  // op de kaart: de foto bovenaan, "+1" voor het geluid
  await waitFor(`document.querySelector('.nc[data-id=${js(made.id)}] .nc-pics.n1 .nc-pic-img.is-loaded')`, 'de foto op de kaart', 10_000);
  assert.equal(await evaluate(`document.querySelector('.nc[data-id=${js(made.id)}] .nc-more-pics').textContent`), '+1');
  assert.equal(savedContent(made.id)?.includes('/geluid'), false, 'de getypte opdracht staat niet in de tekst');
  await closeToasts();
  step('notities: foto\'s en geluid kiezen (een pdf niet), een schermafdruk plakken, afspelen, groot bekijken met vorige/volgende, verwijderen na een vraag; /geluid in het menu; op de kaart de foto met "+1"');

  // ---- versiegeschiedenis: een wijziging van een ander apparaat na een pauze, de versie bekijken en terugzetten, ongedaan maken ----
  db.prepare("UPDATE note_revisions SET created_at = '2000-01-01T00:00:00.000Z'").run(); // alsof de laatste versie lang geleden is
  const mine = savedContent(made.id);
  await as(aliceToken, [['note_update', { id: made.id, content: 'Versie van een ander apparaat\n- [ ] koffie' }]]);
  await click(`[data-fk="note:${made.id}"]`);
  await waitFor(`document.querySelector('dialog[open] .ned')?.textContent.includes('Versie van een ander apparaat')`, 'de notitie met de nieuwe tekst', 10_000);
  await click('dialog[open] [data-fk="note:more"]');
  await click('dialog[open] [data-fk="note-menu:history"]');
  await waitFor(`document.querySelector('.dialog-history[open] .nh-entry:not(.nh-current)')`, 'de versies', 10_000);
  assert.equal(await evaluate(`document.querySelector('.dialog-history[open] .nh-current .nh-label').textContent`), 'Huidige versie');
  assert.equal(await evaluate(`document.querySelector('.dialog-history[open] .nh-day').textContent`), 'Vandaag');
  assert.equal(await evaluate(`document.querySelector('.dialog-history[open] .nh-entry:not(.nh-current) .nh-label').textContent`), 'Eerdere versie');
  await evaluate(`document.querySelector('.dialog-history[open] .nh-entry:not(.nh-current)').click()`);
  await waitFor(`document.querySelector('.dialog-history[open] .nh-text')?.textContent.includes('Na de lijst')`, 'de vorige tekst met opmaak');
  assert.match(await evaluate<string>(`document.querySelector('.dialog-history[open] .nh-summary').textContent`), /^\d+ toegevoegd · \d+ verwijderd · \d+ gewijzigd tot de huidige versie$/);
  await click('.dialog-history[open] [data-fk="nh-mode:changes"]');
  await waitFor(`document.querySelector('.dialog-history[open] .nh-line-add')`, 'de wijzigingen regel voor regel');
  assert.ok((await evaluate<string[]>(`[...document.querySelectorAll('.dialog-history[open] .nh-line-add')].map((e) => e.textContent)`)).some((l) => l.includes('koffie')), 'wat erbij kwam');
  await shot('notitie-versies');
  await click('.dialog-history[open] [data-fk="nh-restore"]');
  await waitFor(`!document.querySelector('.dialog-history[open]')`, 'het venster sluit');
  await waitFor(`document.querySelector('dialog[open] .ned')?.textContent.includes('Na de lijst') && !document.querySelector('dialog[open] .ned').textContent.includes('Versie van een ander apparaat')`, 'de oude tekst staat weer in de editor', 10_000);
  await synced();
  assert.equal(savedContent(made.id), mine, 'zo ook op de server');
  // ongedaan maken in de melding
  await waitFor(`[...document.querySelectorAll('.toast')].some((e) => e.textContent.includes('Versie teruggezet.'))`, 'de melding');
  await evaluate(`[...document.querySelectorAll('.toast')].find((e) => e.textContent.includes('Versie teruggezet.')).querySelector('button:not(.toast-close)').click()`);
  await waitFor(`document.querySelector('dialog[open] .ned')?.textContent.includes('Versie van een ander apparaat')`, 'weer de nieuwste tekst', 10_000);
  await synced();
  assert.equal(savedContent(made.id), 'Versie van een ander apparaat\n- [ ] koffie');
  // en terug naar de eigen tekst, zodat de rest van het scenario klopt
  await as(aliceToken, [['note_update', { id: made.id, content: mine }]]);
  await waitFor(`document.querySelector('dialog[open] .ned')?.textContent.includes('Na de lijst')`, 'de eigen tekst', 10_000);
  await click('dialog[open] [data-fk="note-close"]');
  await waitFor(`!document.querySelector('dialog[open]')`, 'venster dicht');
  await closeToasts();
  step('notities: versiegeschiedenis: een versie van vóór de wijziging op een ander apparaat, per dag, met opmaak en regel voor regel; terugzetten en ongedaan maken');

  // ---- meer notities van een ander apparaat: Overige, zoeken (ook in het archief), indeling ----
  await as(aliceToken, [
    ['note_add', { id: 'e2enotitie000001', title: 'Recept pannenkoeken', content: 'Meel, **melk** en een ei. Crème brûlée als toetje.', background: 'orange' }],
    ['note_add', { id: 'e2enotitie000002', title: 'Fietsroute', content: 'Over de dijk naar Café de Brug', is_archived: true }],
    ['note_add', { id: 'e2enotitie000003', title: 'Onveilig', content: '<script>window.__notitie = true</script> [klik](javascript:alert(1)) <img src=x onerror="window.__notitie=true">' }],
  ]);
  await waitFor(`document.querySelectorAll('.nc').length === 3`, 'nieuwe notities komen vanzelf binnen (het archief niet)', 15_000);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.note-group-title')].map((e) => e.textContent)`), ['Vastgepind1', 'Overige2']);
  await evaluate(`(() => { const i = document.querySelector('[data-fk="notes-search"]'); i.focus(); i.value = 'creme brulee'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor(`document.querySelectorAll('.nc').length === 1 && [...document.querySelectorAll('.nc-hit')].map((e) => e.textContent).join('|') === 'Crème|brûlée'`, 'zoeken zonder accenten, met elk woord gemarkeerd');
  await evaluate(`(() => { const i = document.querySelector('[data-fk="notes-search"]'); i.value = 'CAFE brug'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor(`document.querySelectorAll('.nc').length === 1 && document.querySelector('.nc-title').textContent === 'Fietsroute' && document.querySelector('.nc-flag')?.textContent === 'Archief'`, 'zoeken vindt ook het archief, met een vlag');
  await evaluate(`(() => { const i = document.querySelector('[data-fk="notes-search"]'); i.value = 'bestaatniet'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor(`document.querySelector('.empty-title')?.textContent === 'Geen resultaten voor “bestaatniet”'`, 'niets gevonden');
  await click('.empty button');
  await waitFor(`document.querySelectorAll('.nc').length === 3`, 'zoekopdracht gewist');
  // de onveilige notitie: alles is tekst
  assert.equal(await evaluate(`window.__notitie === true`), false);
  await evaluate(`[...document.querySelectorAll('.nc')].find((c) => c.querySelector('.nc-title')?.textContent === 'Onveilig').querySelector('.nc-open').click()`);
  await waitFor(`document.querySelector('dialog[open] .ned')`, 'de onveilige notitie open');
  assert.equal(await evaluate(`document.querySelectorAll('dialog[open] .ned script, dialog[open] .ned img, dialog[open] .ned a').length`), 0, 'geen script, afbeelding of link');
  assert.ok((await evaluate<string>(`document.querySelector('dialog[open] .ned').textContent`)).includes('<script>'));
  assert.equal(await evaluate(`window.__notitie === true`), false);
  await click('dialog[open] [data-fk="note-close"]');
  await waitFor(`!document.querySelector('dialog[open]')`, 'dicht');
  // indeling: lijst, sorteren op titel
  await click('[data-fk="notes-view"]');
  await click('dialog[open] [data-fk="notes-opt:list"]');
  await synced();
  assert.equal((serverState().settings as any[])[0].note_prefs.layout, 'list', 'de indeling staat in je instellingen');
  await waitFor(`document.querySelector('.note-board.layout-list')`, 'lijst');
  await click('[data-fk="notes-view"]');
  await click('dialog[open] [data-fk="notes-opt:title"]');
  await waitFor(`[...document.querySelectorAll('.note-group[data-group="others"] .nc-title')].map((e) => e.textContent).join('|') === 'Onveilig|Recept pannenkoeken'`, 'op titel A tot Z');
  await click('[data-fk="notes-view"]');
  await click('dialog[open] [data-fk="notes-opt:masonry"]');
  await waitFor(`document.querySelector('.note-cards.masonry .nc-col')`, 'metselwerk in kolommen');
  step('notities: notities van een ander apparaat komen binnen in Overige; zoeken zonder accenten en ook in het archief (met vlag), "Geen resultaten" met wissen; onveilige tekst blijft tekst; indeling lijst, sorteren op titel, metselwerk; in je instellingen');

  // ---- label in de zijbalk, selecteren, archief, prullenbak ----
  await waitFor(`document.querySelector('[data-fk="nav-notes-label:${labelId}"]')`, 'het label onder Notities');
  await click(`[data-fk="nav-notes-label:${labelId}"]`);
  await waitFor(`document.getElementById('view-title').textContent === 'Boodschappen' && document.querySelectorAll('.nc').length === 1`, 'notities met het label');
  await nav('Notities');
  await click('[data-fk="notes-select"]');
  await evaluate(`[...document.querySelectorAll('.nc')].filter((c) => c.querySelector('.nc-title')?.textContent !== 'Boodschappen & ideeën').forEach((c) => c.querySelector('.nc-open').click())`);
  assert.equal(await evaluate(`document.querySelector('.note-bulk-count').textContent`), '2 geselecteerd');
  await click('[data-fk="notes-bulk:archive"]');
  await synced();
  assert.equal(notes().filter((n) => n.is_archived).length, 3);
  await click('[data-fk="nav-notes-archive"]');
  await waitFor(`document.getElementById('view-title').textContent === 'Archief' && document.querySelectorAll('.nc').length === 3`, 'het archief');
  await click('[data-fk="notes-select"]');
  await click('[data-fk="notes-bulk:all"]');
  await click('[data-fk="notes-bulk:trash"]');
  await synced();
  await click('[data-fk="nav-notes-trash"]');
  await waitFor(`document.getElementById('view-title').textContent === 'Prullenbak' && document.querySelectorAll('.nc').length === 3`, 'de prullenbak');
  assert.equal(await evaluate(`document.querySelector('.nc-date').textContent`), 'Nog 30 dagen');
  await shot('notities-prullenbak');
  await evaluate(`[...document.querySelectorAll('.nc')].find((c) => c.querySelector('.nc-title')?.textContent === 'Fietsroute').querySelector('.nc-restore').click()`);
  await synced();
  assert.equal(notes().find((n) => n.id === 'e2enotitie000002').trashed_at, null, 'teruggezet');
  await click('[data-fk="notes-empty-trash"]');
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Prullenbak leegmaken?'`, 'bevestiging');
  await evaluate(`[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Prullenbak leegmaken').click()`);
  await synced();
  assert.deepEqual(notes().map((n) => n.id).sort(), [made.id, 'e2enotitie000002'].sort(), 'de rest is definitief weg');
  step('notities: een label in de zijbalk, selecteren en archiveren, in het archief alles selecteren en naar de prullenbak ("Nog 30 dagen"), terugzetten en de prullenbak leegmaken');

  // ---- privé; een lege nieuwe notitie verdwijnt ----
  const bobView = await as(bobToken, []);
  assert.deepEqual((bobView.notes ?? []).filter((n: any) => !n.is_deleted), [], 'Bob ziet geen notities van Alice');
  await nav('Notities');
  const count = notes().length;
  await click('[data-fk="notes-new"]');
  await waitFor(`document.querySelector('dialog[open] .note-title')`, 'nieuwe notitie');
  await click('dialog[open] [data-fk="note-close"]');
  await waitFor(`!document.querySelector('dialog[open]')`, 'dicht');
  await synced();
  assert.equal(notes().length, count, 'een lege nieuwe notitie wordt weer weggehaald');
  step('notities: privé (een ander ziet ze niet), en een nieuwe notitie die leeg blijft verdwijnt weer');

  // ---- telefoon en donker ----
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(300);
  assert.equal(await evaluate(`document.documentElement.scrollWidth`), 390, 'geen horizontaal scrollen');
  const small = await evaluate<string[]>(`[...document.querySelectorAll('#content button, #content input, .view-actions button')].filter((e) => e.offsetParent !== null && !e.classList.contains('nc-open')).map((e) => { const r = e.getBoundingClientRect(); return r.height < 44 ? (e.dataset.fk || e.textContent || e.className) + ' ' + Math.round(r.height) : null; }).filter(Boolean)`);
  assert.deepEqual(small, [], 'tikvlakken van minstens 44 px');
  await evaluate(`document.querySelector('.nc[data-id=${js(made.id)}] .nc-open').click()`);
  await waitFor(`document.querySelector('dialog[open] .ned')`, 'editor op een telefoon');
  await sleep(200);
  assert.equal(await evaluate(`document.documentElement.scrollWidth`), 390, 'ook met het venster open');
  assert.equal(await evaluate(`Math.round(document.querySelector('dialog[open]').getBoundingClientRect().width)`), 390, 'het venster vult de breedte');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('dialog[open] .ned-toolbar')).position`), 'fixed', 'de werkbalk staat onderaan');
  const smallDialog = await evaluate<string[]>(`[...document.querySelectorAll('dialog[open] .note-bar button, dialog[open] .ned-tool, dialog[open] .note-tag-add')].filter((e) => e.offsetParent !== null).map((e) => { const r = e.getBoundingClientRect(); return r.height < 44 ? (e.dataset.fk || e.textContent) + ' ' + Math.round(r.height) : null; }).filter(Boolean)`);
  assert.deepEqual(smallDialog, [], 'knoppen in het venster zijn minstens 44 px');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(200);
  await shot('notitie-telefoon-donker');
  await click('dialog[open] [data-fk="note-close"]');
  await waitFor(`!document.querySelector('dialog[open]')`, 'dicht');
  await shot('notities-telefoon-donker');
  await send('Emulation.setEmulatedMedia', { features: [] });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  step('notities: op een telefoon geen zijwaarts scrollen, tikvlakken van 44 px, de editor over het hele scherm met de werkbalk onderaan; ook in het donker');

  // ---- importeren: een Takeout-zip van Keep (lijst, kleur, label, foto, archief, prullenbak) en een Markdown-bestand ----
  const keepJson = (o: object) => JSON.stringify({ isTrashed: false, isPinned: false, isArchived: false, userEditedTimestampUsec: 1, color: 'DEFAULT', ...o });
  const takeout = await makeZip([
    { name: 'Takeout/Keep/Kamperen.json', data: keepJson({ title: 'Kamperen', color: 'GREEN', labels: [{ name: 'Vakantie' }], listContent: [{ text: 'tent', isChecked: true }, { text: 'slaapzak', isChecked: false }], attachments: [{ filePath: 'kampeerplek.png', mimetype: 'image/png' }] }), method: 8 },
    { name: 'Takeout/Keep/kampeerplek.png', data: png, method: 0 },
    { name: 'Takeout/Keep/Oud idee.json', data: keepJson({ title: 'Oud idee', textContent: '*geen* opmaak', isArchived: true }), method: 8 },
    { name: 'Takeout/Keep/Weggegooid.json', data: keepJson({ title: 'Weggegooid', textContent: 'x', isTrashed: true }), method: 8 },
    { name: 'Takeout/Keep/Labels.txt', data: 'Vakantie', method: 8 },
  ]);
  const importFiles = { zip: `${filesDir}takeout.zip`, md: `${filesDir}Leeslijst.md` };
  writeFileSync(importFiles.zip, takeout);
  writeFileSync(importFiles.md, '---\ntags: [boeken]\n---\n# Leeslijst\n\n- [ ] Max Havelaar\n- [x] De avonden');
  await click('[data-fk="notes-view"]');
  await waitFor(`document.querySelector('dialog[open] [data-fk="notes-import"]')`, 'de knop importeren in Indeling');
  await click('dialog[open] [data-fk="notes-import"]');
  await waitFor(`document.querySelector('.dialog-note-import[open] [data-fk="note-import-input"]')`, 'het importvenster');
  {
    const { result } = await send('Runtime.evaluate', { expression: `document.querySelector('.dialog-note-import[open] [data-fk="note-import-input"]')` });
    await send('DOM.setFileInputFiles', { files: [importFiles.zip, importFiles.md], objectId: result.objectId });
  }
  await waitFor(`document.querySelector('.dialog-note-import[open] .ni-found')`, 'wat er gevonden is', 15_000);
  assert.equal(await evaluate(`document.querySelector('.dialog-note-import[open] .ni-found').textContent`), "3 notities gevonden · 1 met foto's of geluid");
  assert.match(await evaluate<string>(`document.querySelector('.dialog-note-import[open] .ni-skipped').textContent`), /Weggegooid\.json: in de prullenbak van Keep/);
  assert.equal(await evaluate(`document.querySelector('.dialog-note-import[open] [data-fk="note-import-go"]').textContent`), '3 notities importeren');
  await click('.dialog-note-import[open] [data-fk="note-import-go"]');
  await waitFor(`!document.querySelector('.dialog-note-import[open]')`, 'het venster sluit');
  await waitFor(`[...document.querySelectorAll('.toast')].some((e) => e.textContent.includes('3 notities geïmporteerd.'))`, 'de melding');
  await synced();
  const imported = () => notes().filter((n) => ['Kamperen', 'Oud idee', 'Leeslijst'].includes(n.title));
  assert.equal(imported().length, 3);
  const kamp = imported().find((n) => n.title === 'Kamperen');
  const vakantie = (serverState().labels as any[]).find((l) => l.name === 'Vakantie' && l.owner_id === alice.id);
  assert.deepEqual([kamp.content, kamp.background, kamp.labels], ['- [x] tent\n- [ ] slaapzak', 'green', [vakantie?.id]], 'lijst, kleur en een eigen label');
  const oud = imported().find((n) => n.title === 'Oud idee');
  assert.deepEqual([oud.content, oud.is_archived], ['\\*geen\\* opmaak', true], 'platte tekst blijft platte tekst; in het archief');
  assert.equal(imported().find((n) => n.title === 'Leeslijst').content, '- [ ] Max Havelaar\n- [x] De avonden');
  for (let i = 0; i < 40 && !(serverState().note_files as any[]).some((f) => f.note_id === kamp.id && !f.is_deleted); i++) await sleep(250);
  assert.ok((serverState().note_files as any[]).some((f) => f.note_id === kamp.id && f.name === 'kampeerplek.png' && !f.is_deleted), 'de foto is geüpload en gekoppeld');
  await closeToasts();
  step('notities: importeren uit een Takeout-zip van Keep (lijst, kleur, eigen label, foto, archief; de prullenbak niet) en uit Markdown (tags, titel uit # …)');

  // ---- delen: Alice deelt met Bob (bewerker, dan lezer, dan weer bewerker); Bob wijzigt de tekst; Bob deelt met Alice ----
  const bobName = (db.prepare('SELECT name FROM users WHERE id = ?').get(bob.id) as any).name as string;
  const bobUser = (db.prepare('SELECT username FROM users WHERE id = ?').get(bob.id) as any).username as string;
  const shares = (): any[] => ((serverState().note_shares as any[]) ?? []).filter((s) => !s.is_deleted);
  await click(`[data-fk="note:${made.id}"]`);
  await waitFor(`document.querySelector('dialog[open] .note-title')?.value === 'Boodschappen & ideeën'`, 'de notitie open');
  await click('dialog[open] [data-fk="note:more"]');
  await click('dialog[open] [data-fk="note-menu:share"]');
  await waitFor(`document.querySelector('.dialog-note-share[open] [data-fk="note-share-username"]')`, 'het deelvenster');
  await evaluate(`(() => { const i = document.querySelector('.dialog-note-share[open] [data-fk="note-share-username"]'); i.value = ${js(bobUser)}; i.dispatchEvent(new Event('input')); })()`);
  await click('.dialog-note-share[open] [data-fk="note-share-invite"]');
  await synced();
  await waitFor(`document.querySelector('.dialog-note-share[open] [data-fk="note-share-role:${bob.id}"]')`, 'Bob in de lijst', 10_000);
  assert.deepEqual(shares().map((s) => [s.note_id, s.user_id, s.role]), [[made.id, bob.id, 'editor']]);
  await evaluate(`(() => { const s = document.querySelector('.dialog-note-share[open] [data-fk="note-share-role:${bob.id}"]'); s.value = 'viewer'; s.dispatchEvent(new Event('change')); })()`);
  await synced();
  assert.equal(shares()[0].role, 'viewer');
  await evaluate(`(() => { const s = document.querySelector('.dialog-note-share[open] [data-fk="note-share-role:${bob.id}"]'); s.value = 'editor'; s.dispatchEvent(new Event('change')); })()`);
  await synced();
  assert.equal(shares()[0].role, 'editor');
  await key('Escape', { vk: 27 });
  await waitFor(`!document.querySelector('.dialog-note-share[open]')`, 'het deelvenster dicht');
  assert.equal(await evaluate(`document.querySelector('dialog[open] [data-fk="note-shared-with"]')?.textContent`), 'Gedeeld met 1 persoon');
  // Bob (op een ander apparaat) past de tekst aan: die komt in de open notitie van Alice
  const before3 = savedContent(made.id);
  await as(bobToken, [['note_update', { id: made.id, content: `${before3}\nmeel (van Bob)` }]]);
  await waitFor(`document.querySelector('dialog[open] .ned')?.textContent.includes('meel (van Bob)')`, 'de wijziging van Bob in beeld', 10_000);
  await click('dialog[open] [data-fk="note-close"]');
  await waitFor(`!document.querySelector('dialog[open]')`, 'dicht');
  await waitFor(`document.querySelector('.nc[data-id=${js(made.id)}] .nc-shared')?.textContent === '1'`, 'de kaart toont dat ze gedeeld is');
  // Bob deelt een notitie met Alice, alleen lezen
  await as(bobToken, [['note_add', { id: 'e2enotitiebob001', title: 'Van Bob', content: 'Lees mee' }], ['note_share', { note_id: 'e2enotitiebob001', username: 'alice', role: 'viewer' }]]);
  const bobCard = `document.querySelector('.nc[data-id="e2enotitiebob001"]')`;
  await waitFor(`${bobCard}?.querySelector('.nc-shared')?.textContent === ${js(bobName)}`, 'de kaart van Bob met zijn naam', 10_000);
  await evaluate(`${bobCard}.querySelector('.nc-open').click()`);
  await waitFor(`document.querySelector('dialog[open] [data-fk="note-shared-by"]')`, 'de notitie van Bob open');
  assert.equal(await evaluate(`document.querySelector('dialog[open] [data-fk="note-shared-by"]').textContent`), `Gedeeld door ${bobName} · Alleen lezen`);
  assert.equal(await evaluate(`document.querySelector('dialog[open] .note-title').readOnly`), true, 'alleen lezen');
  assert.equal(await evaluate(`document.querySelector('dialog[open] .ned').getAttribute('contenteditable')`), 'false');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('dialog[open] .note-bar-right [data-fk]')].map((b) => b.dataset.fk)`), ['note:more'], 'geen kleur, belletje of punaise');
  await click('dialog[open] [data-fk="note:more"]');
  await click('dialog[open] [data-fk="note-menu:leave"]');
  await waitFor(`[...document.querySelectorAll('dialog[open] .dialog-buttons .button-danger')].some((b) => b.textContent === 'Weghalen')`, 'de vraag');
  await evaluate(`[...document.querySelectorAll('dialog[open] .dialog-buttons .button-danger')].find((b) => b.textContent === 'Weghalen').click()`);
  await waitFor(`!document.querySelector('dialog[open]') && !${bobCard}`, 'weg uit de notities van Alice', 10_000);
  await synced();
  assert.equal(((serverState(bob.id).notes as any[]) ?? []).some((x) => x.id === 'e2enotitiebob001'), true, 'bij Bob bestaat ze nog');
  assert.equal(((serverState().note_shares as any[]) ?? []).some((s) => s.note_id === 'e2enotitiebob001' && !s.is_deleted), false);
  await as(bobToken, [['note_delete', { id: 'e2enotitiebob001' }]]);
  await closeToasts();
  step('notities: delen op gebruikersnaam (bewerker, lezer), een wijziging van de ander komt live binnen, "Gedeeld met 1 persoon"; een notitie van een ander alleen lezen en "Uit mijn notities halen"');

  // ---- opruimen ----
  const boeken = (serverState().labels as any[]).filter((l) => ['Vakantie', 'boeken'].includes(l.name) && l.owner_id === alice.id).map((l) => ['label_delete', { id: l.id }] as [string, object]);
  await as(aliceToken, [...notes().map((n) => ['note_delete', { id: n.id }] as [string, object]), ['label_delete', { id: labelId }], ...boeken, ['settings_update', { id: `settings-${alice.id}`, note_prefs: null }]]);
  assert.equal(notes().length, before);
  await nav(startView);
  await waitFor(`document.getElementById('view-title').textContent === ${js(startView)}`, 'terug bij het begin');
}
