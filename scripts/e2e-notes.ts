// Notities in een echte browser, tegen de echte server, zoals Anchor: de regel in de zijbalk, een notitie maken met N, typen met opmaak in
// beeld (Markdown-sneltoetsen, het /-menu, de werkbalk, markeren), checklists die afgevinkte punten naar onderen zetten en inklappen,
// plakken (ook onveilige HTML), ongedaan maken, achtergrond, vastpinnen, labels, de kaarten met "gedaan", zoeken, indeling, selecteren,
// archief en prullenbak, privé voor een ander, en op een telefoon en in het donker. Wordt aangeroepen vanuit scripts/e2e.ts.

import assert from 'node:assert/strict';
import { createSession } from '../server/users.ts';

export async function notesScenario(c: any) {
  const { send, evaluate, waitFor, step, shot, sleep, js, SYNCED, db, alice, bob, syncAs, serverState, click, nav } = c;
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
  step('notities: de kaart bij Vastgepind met achtergrond, opmaak, "1 gedaan", het label en "Vandaag"');

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

  // ---- opruimen ----
  await as(aliceToken, [...notes().map((n) => ['note_delete', { id: n.id }] as [string, object]), ['label_delete', { id: labelId }], ['settings_update', { id: `settings-${alice.id}`, note_prefs: null }]]);
  assert.equal(notes().length, before);
  await nav(startView);
  await waitFor(`document.getElementById('view-title').textContent === ${js(startView)}`, 'terug bij het begin');
}
