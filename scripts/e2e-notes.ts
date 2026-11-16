// Notities in een echte browser, tegen de echte server: de regel in de zijbalk, een notitie maken en schrijven (Markdown met werkbalk),
// lezen met aanklikbare vinkjes, vastpinnen, kleur, labels, zoeken, archief en prullenbak, onveilige tekst, privé voor een ander,
// en op een telefoon en in het donker. Wordt aangeroepen vanuit scripts/e2e.ts; de hulpfuncties komen via `c`.

import assert from 'node:assert/strict';
import { createSession } from '../server/users.ts';

export async function notesScenario(c: any) {
  const { send, evaluate, waitFor, step, shot, sleep, js, SYNCED, db, alice, bob, syncAs, serverState, click, nav, typeInto } = c;
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
  const cards = () => evaluate<string[]>(`[...document.querySelectorAll('.note-card .note-card-title')].map((e) => e.textContent)`);
  const closeDialog = async () => {
    await click('dialog[open] [data-fk="note-close"]');
    await waitFor(`!document.querySelector('dialog[open]')`, 'venster dicht');
    await synced();
  };
  const openCard = (title: string) => evaluate(`[...document.querySelectorAll('.note-card')].find((l) => l.querySelector('.note-card-title').textContent === ${js(title)}).querySelector('.note-card-open').click()`);
  const tool = (name: string) => click(`dialog[open] [data-fk="note-tool:${name}"]`);
  const text = () => evaluate<string>(`document.querySelector('dialog[open] .note-text').value`);
  const closeToasts = () => evaluate(`document.querySelectorAll('.toast-close').forEach((b) => b.click())`);
  const before = notes().length;

  // ---- de regel in de zijbalk en de lege staat ----
  await closeToasts();
  await waitFor(`[...document.querySelectorAll('.nav-item .nav-label')].some((e) => e.textContent === 'Notities')`, 'Notities in de zijbalk');
  await nav('Notities');
  await waitFor(`document.getElementById('view-title').textContent === 'Notities'`, 'het scherm Notities');
  assert.equal(await evaluate(`document.title`), 'Notities · Tickory');
  assert.equal(await evaluate(`document.querySelector('.empty-title')?.textContent`), 'Nog geen notities');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.note-tab')].map((b) => b.firstChild.textContent)`), ['Alle notities', 'Archief', 'Prullenbak']);

  // ---- een notitie maken en schrijven ----
  await click('[data-fk="notes-new"]');
  await waitFor(`document.querySelector('dialog[open] .note-title-input')`, 'het editorvenster');
  assert.equal(await evaluate(`document.activeElement?.dataset?.fk`), 'note-title', 'een nieuwe notitie begint bij de titel');
  assert.equal(await evaluate(`document.querySelector('dialog[open] .note-text').hidden`), false, 'een nieuwe notitie opent in de schrijfstand');
  await typeInto('dialog[open] .note-title-input', 'Boodschappen & ideeën');
  await typeInto('dialog[open] .note-text', 'Vandaag halen:\n- [ ] melk\n- [x] brood\n\nZie https://example.org/lijst en <script>alert(1)</script> en [klik](javascript:alert(1)).');
  await waitFor(`await ${SYNCED}`, 'bewaard', 15_000);
  await waitFor(`document.querySelector('dialog[open] .note-status').textContent === 'Opgeslagen'`, 'Opgeslagen', 5_000);
  const made = notes().find((n) => n.title === 'Boodschappen & ideeën');
  assert.ok(made, 'de notitie staat op de server');
  assert.equal(made.owner_id, alice.id);
  assert.match(made.content, /^Vandaag halen:\n- \[ \] melk\n- \[x\] brood/);
  await shot('notitie-schrijven');

  // de werkbalk: vet om een selectie, een lijst, een kop
  await evaluate(`(() => { const a = document.querySelector('dialog[open] .note-text'); a.value = 'tekst'; a.setSelectionRange(0, 5); a.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await tool('bold');
  assert.equal(await text(), '**tekst**');
  await tool('bold');
  assert.equal(await text(), 'tekst', 'nog eens Vet haalt de sterretjes weer weg');
  await evaluate(`(() => { const a = document.querySelector('dialog[open] .note-text'); a.value = 'een\\ntwee'; a.setSelectionRange(0, 8); a.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await tool('bullets');
  assert.equal(await text(), '- een\n- twee');
  await tool('bullets');
  assert.equal(await text(), 'een\ntwee', 'nog eens haalt de punten weer weg');
  await tool('tasks');
  assert.equal(await text(), '- [ ] een\n- [ ] twee');
  await tool('table');
  assert.equal(await text(), '- [ ] een\n- [ ] twee\n| Kolom 1 | Kolom 2 |\n|---|---|\n|  |  |\n', 'de tabel komt na de selectie, de lijst blijft staan');
  // Enter in een lijst gaat door met het volgende punt; bij een leeg punt stopt de lijst
  await evaluate(`(() => { const a = document.querySelector('dialog[open] .note-text'); a.value = '- [ ] eerste'; a.setSelectionRange(12, 12); a.focus(); })()`);
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  assert.equal(await text(), '- [ ] eerste\n- [ ] ');
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  assert.equal(await text(), '- [ ] eerste\n', 'een leeg punt sluit de lijst af');
  // terug naar de echte tekst
  await typeInto('dialog[open] .note-text', made.content);
  await waitFor(`await ${SYNCED}`, 'bewaard', 15_000);
  step('notities: de regel in de zijbalk, de lege staat, een nieuwe notitie die opent bij de titel, vanzelf bewaard op de server (alleen van Alice), en de werkbalk (vet, lijst, taken, tabel, Enter in een lijst)');

  // ---- lezen: Markdown als opmaak, onveilige tekst blijft tekst, vinkjes zijn aan te klikken ----
  await click('dialog[open] [data-fk="note:mode"]');
  await waitFor(`!document.querySelector('dialog[open] .note-read').hidden`, 'leesstand');
  assert.equal(await evaluate(`document.querySelectorAll('dialog[open] .note-read .md-check').length`), 2);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('dialog[open] .note-read .md-check')].map((b) => b.checked)`), [false, true]);
  assert.equal(await evaluate(`document.querySelectorAll('dialog[open] .note-read script, dialog[open] .note-read img, dialog[open] .note-read iframe').length`), 0, 'geen script of afbeelding uit de tekst');
  assert.ok((await evaluate<string>(`document.querySelector('dialog[open] .note-read').textContent`)).includes('<script>alert(1)</script>'), 'het script staat als tekst');
  const hrefs = await evaluate<string[]>(`[...document.querySelectorAll('dialog[open] .note-read a')].map((a) => a.getAttribute('href'))`);
  assert.deepEqual(hrefs, ['https://example.org/lijst'], 'alleen het echte webadres is een link; javascript: niet');
  assert.equal(await evaluate(`document.querySelector('dialog[open] .note-read a').rel`), 'noopener noreferrer nofollow');
  assert.equal(await evaluate(`document.querySelector('dialog[open] .note-read a').target`), '_blank');
  await evaluate(`document.querySelectorAll('dialog[open] .note-read .md-check')[0].click()`);
  await waitFor(`await ${SYNCED}`, 'vinkje bewaard', 15_000);
  assert.match(notes().find((n) => n.id === made.id).content, /- \[x\] melk\n- \[x\] brood/, 'het vinkje staat in de tekst op de server');
  await shot('notitie-lezen');
  step('notities: de leesstand toont Markdown als opmaak, een script of javascript:-link in de tekst blijft tekst, alleen echte webadressen zijn links, en een vinkje aanklikken wordt direct bewaard');

  // ---- vastpinnen, kleur en labels ----
  await click('dialog[open] [data-fk="note:pin"]');
  await click('dialog[open] [data-fk="note:labels"]');
  await waitFor(`!document.querySelector('dialog[open] .note-labels-panel').hidden`, 'labels open');
  await typeInto('dialog[open] [data-fk="note-new-label"]', 'Boodschappen');
  await evaluate(`document.querySelector('dialog[open] [data-fk="note-new-label"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await waitFor(`await ${SYNCED}`, 'label gemaakt', 15_000);
  const labelId = (serverState().labels as any[]).find((l) => l.name === 'Boodschappen' && l.owner_id === alice.id)?.id;
  assert.ok(labelId, 'het label bestaat');
  await waitFor(`document.querySelector('dialog[open] [data-fk="note-label:${labelId}"]')?.checked === true`, 'het nieuwe label staat op de notitie', 10_000);
  await evaluate(`document.querySelector('dialog[open] .note-colors input[value="teal"]').click()`);
  await synced();
  const row = notes().find((n) => n.id === made.id);
  assert.deepEqual([row.is_pinned, row.color, row.labels], [true, 'teal', [labelId]]);
  await closeDialog();
  assert.deepEqual(await cards(), ['Boodschappen & ideeën']);
  assert.equal(await evaluate(`document.querySelector('.note-card').classList.contains('note-pinned')`), true);
  assert.equal(await evaluate(`document.querySelector('.note-card .note-pin') !== null`), true);
  assert.equal(await evaluate(`document.querySelector('.note-card .chip').textContent`), 'Boodschappen');
  assert.ok((await evaluate<string>(`document.querySelector('.note-snippet').textContent`)).startsWith('Vandaag halen:'), 'het voorbeeld zonder opmaaktekens');
  await shot('notities-lijst');
  step('notities: vastpinnen, een kleur en een nieuw label (direct op de notitie) komen op de server en op de kaart');

  // ---- meer notities: van een ander apparaat, volgorde, zoeken, labelfilter ----
  await as(aliceToken, [
    ['note_add', { id: 'e2enotitie000001', title: 'Recept pannenkoeken', content: 'Meel, **melk** en een ei. Crème brûlée als toetje.', color: 'orange' }],
    ['note_add', { id: 'e2enotitie000002', title: 'Fietsroute', content: 'Over de dijk naar Café de Brug' }],
  ]);
  await waitFor(`document.querySelectorAll('.note-card').length === 3`, 'twee notities van een ander apparaat komen vanzelf binnen', 15_000);
  assert.equal((await cards())[0], 'Boodschappen & ideeën', 'vastgepind staat vooraan');
  await typeInto('[data-fk="notes-search"]', 'creme brulee');
  await waitFor(`document.querySelectorAll('.note-card').length === 1`, 'zoeken zonder accenten');
  assert.deepEqual(await cards(), ['Recept pannenkoeken']);
  assert.equal(await evaluate(`document.querySelector('.note-snippet mark')?.textContent`), 'Crème brûlée', 'de treffer is gemarkeerd');
  await typeInto('[data-fk="notes-search"]', 'CAFE brug');
  await waitFor(`document.querySelectorAll('.note-card').length === 1 && document.querySelector('.note-card-title').textContent === 'Fietsroute'`, 'hoofdletters en volgorde tellen niet');
  await typeInto('[data-fk="notes-search"]', 'bestaatniet');
  await waitFor(`document.querySelector('.empty-title')?.textContent === 'Niets gevonden'`, 'niets gevonden');
  await typeInto('[data-fk="notes-search"]', '');
  await waitFor(`document.querySelectorAll('.note-card').length === 3`, 'alles terug');
  await click(`[data-fk="notes-label:${labelId}"]`);
  await waitFor(`document.getElementById('view-title').textContent === 'Boodschappen' && document.querySelectorAll('.note-card').length === 1`, 'gefilterd op het label');
  await click(`[data-fk="notes-label:${labelId}"]`);
  await waitFor(`document.getElementById('view-title').textContent === 'Notities'`, 'filter weer uit');
  step('notities: een notitie van een ander apparaat verschijnt vanzelf, zoeken (zonder accenten, hoofdletters en volgorde) met gemarkeerde treffer, "niets gevonden", en filteren op label');

  // ---- archief en prullenbak ----
  await openCard('Fietsroute');
  await waitFor(`document.querySelector('dialog[open] [data-fk="note:archive"]')`, 'editor');
  await click('dialog[open] [data-fk="note:archive"]');
  await waitFor(`!document.querySelector('dialog[open]')`, 'venster sluit na archiveren');
  await synced();
  assert.equal(notes().find((n) => n.id === 'e2enotitie000002').is_archived, true);
  await closeToasts();
  assert.equal((await cards()).includes('Fietsroute'), false, 'niet meer bij alle notities');
  await click('[data-fk="notes-tab:archive"]');
  await waitFor(`document.getElementById('view-title').textContent === 'Archief' && document.querySelectorAll('.note-card').length === 1`, 'het archief');
  await openCard('Fietsroute');
  await click('dialog[open] [data-fk="note:trash"]');
  await waitFor(`!document.querySelector('dialog[open]')`, 'venster sluit na de prullenbak');
  await synced();
  const trashed = notes().find((n) => n.id === 'e2enotitie000002');
  assert.ok(trashed.trashed_at && Math.abs(Date.now() - Date.parse(trashed.trashed_at)) < 60_000, 'het tijdstip staat op de server');
  await click('[data-fk="notes-tab:trash"]');
  await waitFor(`document.getElementById('view-title').textContent === 'Prullenbak' && document.querySelectorAll('.note-card').length === 1`, 'de prullenbak');
  assert.equal(await evaluate(`document.querySelector('.note-card-foot').textContent`), 'Nog 30 dagen');
  await shot('notities-prullenbak');
  await click('[data-fk^="note-restore:"]');
  await synced();
  assert.equal(notes().find((n) => n.id === 'e2enotitie000002').trashed_at, null, 'teruggezet');
  // de prullenbak leegmaken
  await nav('Notities');
  await waitFor(`document.getElementById('view-title').textContent === 'Notities'`, 'terug bij Notities');
  await as(aliceToken, [['note_update', { id: 'e2enotitie000001', trashed_at: new Date().toISOString() }]]);
  await click('[data-fk="notes-tab:trash"]');
  await waitFor(`document.querySelectorAll('.note-card').length === 1`, 'een notitie in de prullenbak');
  await click('[data-fk="notes-empty-trash"]');
  await waitFor(`document.querySelector('dialog[open] h2')?.textContent === 'Prullenbak leegmaken?'`, 'bevestiging');
  await evaluate(`[...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Prullenbak leegmaken').click()`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'bevestigd');
  await synced();
  assert.equal(notes().some((n) => n.id === 'e2enotitie000001'), false, 'definitief weg van de server');
  step('notities: archiveren, naar de prullenbak (met het tijdstip en "Nog 30 dagen"), terugzetten en de prullenbak leegmaken met bevestiging');

  // ---- privé, en een lege nieuwe notitie verdwijnt weer ----
  const bobView = await as(bobToken, []);
  assert.deepEqual((bobView.notes ?? []).filter((n: any) => !n.is_deleted), [], 'Bob ziet geen notities van Alice');
  await nav('Notities');
  await click('[data-fk="notes-tab:all"]');
  const count = notes().length;
  await click('[data-fk="notes-new"]');
  await waitFor(`document.querySelector('dialog[open] .note-title-input')`, 'nieuwe notitie');
  await sleep(300);
  await closeDialog();
  assert.equal(notes().length, count, 'een lege nieuwe notitie wordt weer weggehaald');
  step('notities: privé (een ander ziet ze niet) en een nieuwe notitie die leeg blijft verdwijnt weer');

  // ---- telefoon en donker ----
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(300);
  assert.equal(await evaluate(`document.documentElement.scrollWidth`), 390, 'geen horizontaal scrollen');
  const small = await evaluate<string[]>(`[...document.querySelectorAll('#content button, #content input, .view-actions button')].filter((e) => e.offsetParent !== null).map((e) => { const r = e.getBoundingClientRect(); return r.height < 44 ? (e.dataset.fk || e.textContent || e.className) + ' ' + Math.round(r.height) : null; }).filter(Boolean)`);
  assert.deepEqual(small, [], 'tikvlakken van minstens 44 px');
  await openCard('Boodschappen & ideeën');
  await waitFor(`document.querySelector('dialog[open] .note-read')`, 'editor op een telefoon');
  await sleep(200);
  assert.equal(await evaluate(`document.documentElement.scrollWidth`), 390, 'ook met het venster open');
  const rect = await evaluate<{ w: number; h: number }>(`(() => { const r = document.querySelector('dialog[open]').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })()`);
  assert.equal(rect.w, 390, 'het venster vult de breedte');
  const smallDialog = await evaluate<string[]>(`[...document.querySelectorAll('dialog[open] button')].filter((e) => e.offsetParent !== null).map((e) => { const r = e.getBoundingClientRect(); return r.height < 44 ? (e.dataset.fk || e.textContent) + ' ' + Math.round(r.height) : null; }).filter(Boolean)`);
  assert.deepEqual(smallDialog, [], 'knoppen in het venster zijn minstens 44 px');
  const checks = await evaluate<number[]>(`[...document.querySelectorAll('dialog[open] .md-check')].map((e) => Math.round(e.getBoundingClientRect().height))`);
  assert.ok(checks.length === 2 && checks.every((x) => x >= 24), `vinkjes van minstens 24 px op een telefoon (${checks})`);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(200);
  await shot('notitie-telefoon-donker');
  await closeDialog();
  await send('Emulation.setEmulatedMedia', { features: [] });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  step('notities: op een telefoon geen zijwaarts scrollen, tikvlakken van minstens 44 px en een venster over het hele scherm; ook in het donker');

  // ---- opruimen ----
  await as(aliceToken, notes().map((n) => ['note_delete', { id: n.id }] as [string, object]));
  await as(aliceToken, [['label_delete', { id: labelId }]]);
  assert.equal(notes().length, before);
  await nav(startView);
  await waitFor(`document.getElementById('view-title').textContent === ${js(startView)}`, 'terug bij het begin');
}
