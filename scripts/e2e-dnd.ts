// Slepen en verplaatsen in een echte browser: echte muis- en aanraakgebaren via het DevTools-protocol (geen gesimuleerde
// gebeurtenissen vanuit de pagina), met controle op de server. Wordt aangeroepen vanuit scripts/e2e.ts; de hulpfuncties van
// die test komen binnen via `c`. Schermafbeeldingen van de sleepstatus komen in .e2e/shots/.

import assert from 'node:assert/strict';
import { handleSync } from '../server/sync.ts';

type Rect = { x: number; y: number; w: number; h: number };

export async function dragAndDropScenario(c: any): Promise<void> {
  try {
    await scenario(c);
  } catch (err) {
    await c.shot('MISLUKT-slepen').catch(() => {}); // wat stond er op het scherm?
    throw err;
  }
}

async function scenario(c: any): Promise<void> {
  const { send, evaluate, waitFor, step, shot, sleep, js, SYNCED, db, alice, bob, syncAs, serverState, otherToken, startServer, stopServer } = c;
  let uuid = 0;
  const cmd = (type: string, args: object) => ({ type, uuid: `e2e-dnd-${String(++uuid).padStart(4, '0')}-${Date.now()}`, args });
  const asAlice = (commands: object[]) => syncAs(otherToken, 'ander-apparaat', commands);
  const asBob = (commands: object[]) => handleSync(db, { commands }, bob.id);

  // ---------- gegevens ----------
  const P = 'dnd-project-0001', P2 = 'dnd-project-0002', P3 = 'dnd-project-0003', LONG = 'dnd-project-long', S1 = 'dnd-section-0001', S2 = 'dnd-section-0002';
  const T = (name: string) => `dnd-task-${name.toLowerCase()}`;
  await asAlice([
    cmd('project_add', { id: P, name: 'Sleepproef' }), cmd('project_add', { id: P2, name: 'Doelproject' }), cmd('project_add', { id: P3, name: 'Naburig' }),
    cmd('section_add', { id: S1, project_id: P, name: 'Eerst' }), cmd('section_add', { id: S2, project_id: P, name: 'Daarna' }),
    ...['Alfa', 'Bravo', 'Charlie'].map((n) => cmd('task_add', { id: T(n), project_id: P, content: n })),
    cmd('task_add', { id: T('Delta'), project_id: P, section_id: S1, content: 'Delta' }),
    cmd('task_add', { id: T('Echo'), project_id: P, section_id: S2, content: 'Echo' }),
    cmd('project_add', { id: LONG, name: 'Lange lijst' }),
    ...Array.from({ length: 40 }, (_, i) => cmd('task_add', { id: `dnd-long-${String(i).padStart(3, '0')}`, project_id: LONG, content: `Regel ${String(i + 1).padStart(2, '0')}` })),
  ]);
  // een project van Bob waar Alice alleen lid van is
  asBob([cmd('project_add', { id: 'dnd-bobs-project', name: 'Van Bob' }), cmd('project_share', { project_id: 'dnd-bobs-project', username: 'alice' })]);
  await waitFor(`[...document.querySelectorAll('.nav-label')].some((e) => e.textContent === 'Van Bob') && [...document.querySelectorAll('.nav-label')].some((e) => e.textContent === 'Naburig')`, 'projecten van de proef in de zijbalk', 15_000);

  // de lijsten Filters en Labels in de zijbalk nemen plaats in: klap ze in (zoals een gebruiker zou doen), zodat alle projecten in beeld blijven
  for (const key of ['filters', 'labels']) await evaluate(`(() => { const b = document.querySelector('[data-fk="find-toggle:${key}"]'); if (b && b.getAttribute('aria-expanded') === 'true') b.click(); })()`);

  // ---------- hulpmiddelen ----------
  const nav = (label: string) => evaluate(`(() => { const el = [...document.querySelectorAll('.nav-item')].find((b) => b.querySelector('.nav-label')?.textContent === ${js(label)}); if (!el) throw new Error('geen menu-item: ' + ${js(label)}); el.click(); })()`);
  const rowExpr = (name: string) => `[...document.querySelectorAll('.task')].find((l) => l.querySelector('.task-title').textContent === ${js(name)})`;
  const navRowExpr = (name: string) => `[...document.querySelectorAll('#sidebar .nav-row')].find((r) => r.querySelector('.nav-label').textContent === ${js(name)})`;
  const rectNow = (expr: string) => evaluate<Rect>(`(() => { const e = ${expr}; if (!e) throw new Error('niet gevonden: ' + ${js(expr.slice(0, 120))}); const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  /**
   * De plek van een element, pas als hij stilstaat: regels met `content-visibility: auto` hebben tot ze zijn gemeten een geschatte
   * hoogte, waardoor de lijst na het openen nog even verspringt. Meten we te vroeg, dan pakt de muis een andere regel.
   */
  const rectOf = async (expr: string) => {
    let last = await rectNow(expr);
    for (let i = 0; i < 20; i++) {
      await sleep(60);
      const now = await rectNow(expr);
      if (now.x === last.x && now.y === last.y && now.w === last.w && now.h === last.h) return now;
      last = now;
    }
    return last;
  };
  const rowRect = (name: string) => rectOf(rowExpr(name));
  const navRect = (name: string) => rectOf(navRowExpr(name));
  const at = (r: Rect, fx: number, fy: number) => ({ x: Math.round(r.x + r.w * fx), y: Math.round(r.y + r.h * fy) });
  // een punt op de titel van een regel (daar begint een muissleep; niet op de cirkel)
  const grab = (r: Rect) => ({ x: Math.round(r.x + Math.min(160, r.w / 2)), y: Math.round(r.y + r.h / 2) });
  const titles = () => evaluate<string[]>(`[...document.querySelectorAll('.task .task-title')].map((e) => e.textContent)`);
  const mouse = (type: string, x: number, y: number, buttons: number) =>
    send('Input.dispatchMouseEvent', { type, x, y, button: buttons || type === 'mouseReleased' ? 'left' : 'none', buttons, clickCount: type === 'mouseMoved' ? 0 : 1, pointerType: 'mouse' });
  /** Een echt muisgebaar: indrukken, in stappen naar het doel, (optioneel iets controleren terwijl je vasthoudt), loslaten. */
  async function drag(from: { x: number; y: number }, to: { x: number; y: number }, during?: () => Promise<void>, steps = 10) {
    await evaluate(`document.querySelectorAll('.toast-close').forEach((b) => b.click())`); // meldingen met Ongedaan maken liggen anders over de onderste regels
    await mouse('mouseMoved', from.x, from.y, 0);
    await mouse('mousePressed', from.x, from.y, 1);
    for (let i = 1; i <= steps; i++) await mouse('mouseMoved', Math.round(from.x + ((to.x - from.x) * i) / steps), Math.round(from.y + ((to.y - from.y) * i) / steps), 1);
    await sleep(80);
    if (during) await during();
    await mouse('mouseReleased', to.x, to.y, 0);
  }
  const settle = async () => { await sleep(150); await waitFor(`await ${SYNCED}`, 'gesynchroniseerd', 15_000); };
  const keyOf = (key: string) => ({ ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Escape: 27 } as Record<string, number>)[key];
  const alt = async (key: string) => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: keyOf(key), modifiers: 1 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: keyOf(key), modifiers: 1 });
  };
  const tasksOnServer = () => serverState().tasks as any[];
  /** De taken in één lijst op de server, op volgorde van sleutel. */
  const serverOrder = (project: string, section: string | null = null, parent: string | null = null) =>
    tasksOnServer().filter((t) => t.project_id === project && (t.section_id ?? null) === section && (t.parent_id ?? null) === parent && !t.is_deleted)
      .sort((a, b) => (a.order_key < b.order_key ? -1 : a.order_key > b.order_key ? 1 : a.id < b.id ? -1 : 1)).map((t) => t.content);
  const projectOnServer = (id: string) => (serverState().projects as any[]).find((p) => p.id === id);
  const projectOrder = (parent: string | null) => (serverState().projects as any[]).filter((p) => (p.parent_id ?? null) === parent && !p.id.startsWith('inbox-'))
    .sort((a, b) => (a.order_key < b.order_key ? -1 : a.order_key > b.order_key ? 1 : a.id < b.id ? -1 : 1)).map((p) => p.name);
  const live = () => evaluate<string>(`document.getElementById('dnd-live')?.textContent ?? ''`);
  const dragState = () => evaluate<{ ghost: boolean; line: boolean; child: string[]; source: string[]; target: number }>(`({
    ghost: Boolean(document.querySelector('.dnd-ghost')), line: Boolean(document.querySelector('.dnd-line')),
    child: [...document.querySelectorAll('.dnd-target-child .task-title, .dnd-target-child .nav-label')].map((e) => e.textContent),
    source: [...document.querySelectorAll('.dnd-source .task-title, .dnd-source .nav-label')].map((e) => e.textContent),
    target: document.querySelectorAll('.dnd-target').length })`);
  const lineY = () => evaluate<number>(`document.querySelector('.dnd-line')?.getBoundingClientRect().top ?? -1`);

  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await waitFor(`innerWidth === 1280`, 'het venster is weer breed (na een telefoonformaat eerder in de test)');
  await sleep(300); // en de indeling is bijgewerkt voordat we gaan meten
  await nav('Sleepproef');
  await waitFor(`document.getElementById('view-title').textContent === 'Sleepproef' && document.querySelectorAll('.task').length === 5`, 'Sleepproef geopend');
  assert.deepEqual(await titles(), ['Alfa', 'Bravo', 'Charlie', 'Delta', 'Echo']);
  assert.equal(await evaluate(`document.querySelectorAll('.group[data-drop-project]').length`), 3, 'drie lijsten waar je in kunt slepen: zonder sectie, Eerst en Daarna');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.drag-handle')).display`), 'block', 'handvat aanwezig in een project');

  // ---------- 1. de muis: volgorde wijzigen met een invoegstreep ----------
  {
    const alfa = await rowRect('Alfa');
    const charlie = await rowRect('Charlie');
    await drag(grab(charlie), at(alfa, 0.5, 0.08), async () => {
      const s = await dragState();
      assert.equal(s.ghost, true, 'een kopie van de taak beweegt mee');
      assert.equal(s.line, true, 'de invoegstreep staat er');
      assert.deepEqual(s.source, ['Charlie'], 'de taak zelf is gedimd');
      assert.ok(Math.abs((await lineY()) - (alfa.y - 1)) <= 2, `de streep staat boven Alfa (${await lineY()} tegen ${alfa.y})`);
      assert.equal(await evaluate(`document.body.classList.contains('dnd-active')`), true);
      await shot('slepen-volgorde');
    });
    await settle();
    assert.deepEqual(serverOrder(P), ['Charlie', 'Alfa', 'Bravo'], 'op de server');
    assert.deepEqual((await titles()).slice(0, 3), ['Charlie', 'Alfa', 'Bravo'], 'in beeld');
    assert.equal(await evaluate(`document.querySelectorAll('.dnd-ghost, .dnd-line, .dnd-source').length`), 0, 'alles netjes opgeruimd');
    assert.equal(await evaluate(`document.querySelector('.dialog[open], dialog[open]') === null`), true, 'loslaten opent het taakvenster niet');
    step('slepen met de muis: een kopie volgt de aanwijzer, de invoegstreep staat boven de juiste taak, loslaten zet de taak er voor en dat staat op de server; het taakvenster gaat niet open');
  }

  // ---------- 2. klikken blijft klikken, ook met een beetje beven ----------
  {
    const alfa = await rowRect('Alfa');
    const p = grab(alfa);
    await mouse('mouseMoved', p.x, p.y, 0);
    await mouse('mousePressed', p.x, p.y, 1);
    await mouse('mouseMoved', p.x + 2, p.y + 1, 1);
    await mouse('mouseReleased', p.x + 2, p.y + 1, 0);
    await waitFor(`document.querySelector('#task-dialog[open]')`, 'klik opent het taakvenster');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await waitFor(`!document.querySelector('dialog[open]')`, 'venster dicht');
    assert.deepEqual(serverOrder(P), ['Charlie', 'Alfa', 'Bravo']);
    // een sleep die op dezelfde regel eindigt (de "klik" na het loslaten valt op dezelfde knop) opent het venster niet
    const again = await rowRect('Alfa');
    const q = grab(again);
    await drag(q, { x: q.x + 10, y: q.y + 12 }, async () => { assert.equal((await dragState()).ghost, true, 'na 5 px bewegen is het een sleep'); });
    await sleep(300);
    assert.equal(await evaluate(`Boolean(document.querySelector('dialog[open]'))`), false, 'losgelaten op dezelfde regel: het taakvenster blijft dicht');
    assert.deepEqual(serverOrder(P), ['Charlie', 'Alfa', 'Bravo']);
    step('een klik (met 2 px beven) opent nog gewoon het taakvenster en verplaatst niets; een sleep die op dezelfde regel eindigt opent het niet');
  }

  // ---------- 3. op een taak laten vallen maakt een subtaak, en eruit slepen haalt hem weer terug ----------
  {
    const alfa = await rowRect('Alfa');
    const bravo = await rowRect('Bravo');
    await drag(grab(bravo), at(alfa, 0.5, 0.5), async () => {
      assert.deepEqual((await dragState()).child, ['Alfa'], 'Alfa is gemarkeerd als nieuwe ouder');
      assert.equal((await dragState()).line, false, 'bij een subtaak hoort geen streep maar een kader');
      await shot('slepen-subtaak');
    });
    await settle();
    assert.equal(tasksOnServer().find((t) => t.content === 'Bravo').parent_id, T('Alfa'));
    assert.deepEqual(serverOrder(P, null, T('Alfa')), ['Bravo']);
    await waitFor(`${rowExpr('Bravo')}?.dataset.depth === '1'`, 'Bravo ingesprongen in beeld');
    // eruit: vóór Charlie
    const charlie = await rowRect('Charlie');
    const sub = await rowRect('Bravo');
    await drag(grab(sub), at(charlie, 0.5, 0.1));
    await settle();
    assert.equal(tasksOnServer().find((t) => t.content === 'Bravo').parent_id, null);
    assert.ok(serverOrder(P).indexOf('Bravo') < serverOrder(P).indexOf('Charlie'), 'Bravo staat nu voor Charlie');
    step('op een taak laten vallen maakt een subtaak (kader om de ouder, geen streep); eruit slepen zet hem als gewone taak terug op de plek van de streep');
  }

  // ---------- 4. naar een andere sectie ----------
  {
    const delta = await rowRect('Delta');
    const alfa = await rowRect('Alfa');
    await drag(grab(alfa), at(delta, 0.5, 0.1));
    await settle();
    assert.deepEqual(serverOrder(P, S1), ['Alfa', 'Delta']);
    // op de kop van een lege-ish sectie: bovenaan; Echo is de enige in "Daarna"
    const head = await rectOf(`[...document.querySelectorAll('.group')].find((g) => g.querySelector('.group-title')?.textContent === 'Daarna').querySelector('.group-head')`);
    const delta2 = await rowRect('Delta');
    await drag(grab(delta2), at(head, 0.5, 0.5), async () => {
      assert.equal((await dragState()).target, 1, 'de kop van de sectie is het doel');
      await shot('slepen-sectie');
    });
    await settle();
    assert.deepEqual(serverOrder(P, S2), ['Delta', 'Echo']);
    step('naar een andere sectie: tussen de taken van die sectie, en op de kop van de sectie komt hij bovenaan');
  }

  // ---------- 5. op een project in de zijbalk laten vallen, met ongedaan maken ----------
  {
    const bravo = await rowRect('Bravo');
    const target = await navRect('Doelproject');
    await drag(grab(bravo), at(target, 0.5, 0.5), async () => {
      assert.equal((await dragState()).target, 1, 'het project in de zijbalk licht op');
      await shot('slepen-naar-project');
    });
    await settle();
    assert.equal(tasksOnServer().find((t) => t.content === 'Bravo').project_id, P2);
    await waitFor(`[...document.querySelectorAll('.toast-text')].some((e) => e.textContent === '"Bravo" verplaatst naar "Doelproject".')`, 'melding met ongedaan maken');
    assert.ok(!(await titles()).includes('Bravo'), 'weg uit de lijst');
    await evaluate(`[...document.querySelectorAll('.toast-action')].find((b) => b.textContent === 'Ongedaan maken').click()`);
    await settle();
    assert.equal(tasksOnServer().find((t) => t.content === 'Bravo').project_id, P, 'terug');
    await waitFor(`(${rowExpr('Bravo')}) !== undefined`, 'Bravo weer in de lijst');
    step('naar een project in de zijbalk slepen verplaatst de taak (melding met "Ongedaan maken", dat hem terugzet)');
  }

  // ---------- 6. Escape annuleert ----------
  {
    const before = await titles();
    const echo = await rowRect('Echo');
    const alfa = await rowRect('Alfa');
    const p = grab(echo);
    await mouse('mouseMoved', p.x, p.y, 0);
    await mouse('mousePressed', p.x, p.y, 1);
    for (let i = 1; i <= 6; i++) await mouse('mouseMoved', p.x, Math.round(p.y + ((alfa.y - p.y) * i) / 6), 1);
    assert.equal((await dragState()).ghost, true);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    assert.equal((await dragState()).ghost, false, 'kopie weg');
    await mouse('mouseReleased', p.x, alfa.y, 0);
    await sleep(300);
    assert.deepEqual(await titles(), before);
    assert.equal(await live(), 'Verplaatsen geannuleerd.');
    step('Escape tijdens het slepen annuleert: niets verplaatst, de schermlezer krijgt een melding');
  }

  // ---------- 7. toetsenbord: Alt + pijl, met aankondiging ----------
  {
    const before = serverOrder(P);
    const K = before[before.length - 1]; // de laatste taak van de lijst
    const idx = before.indexOf(K);
    await evaluate(`${rowExpr(K)}.querySelector('.task-body').focus()`);
    await alt('ArrowUp');
    await settle();
    const after = serverOrder(P);
    assert.equal(after.indexOf(K), idx - 1, `een plek omhoog (${before} -> ${after})`);
    assert.match(await live(), new RegExp(`^"${K}" staat nu op plek ${idx}, totaal ${before.length} in "Sleepproef"\\.$`));
    assert.equal(await evaluate(`document.activeElement?.closest('.task')?.querySelector('.task-title').textContent`), K, 'de focus blijft bij de taak');
    await alt('ArrowDown');
    await settle();
    assert.deepEqual(serverOrder(P), before);
    // inspringen en weer uit
    await alt('ArrowRight');
    await settle();
    const parent = tasksOnServer().find((t) => t.content === K).parent_id;
    assert.ok(parent, 'subtaak van de taak erboven');
    assert.match(await live(), new RegExp(`^"${K}" is nu een subtaak van "`));
    await alt('ArrowLeft');
    await settle();
    assert.equal(tasksOnServer().find((t) => t.content === K).parent_id, null);
    assert.match(await live(), new RegExp(`^"${K}" staat niet meer onder "`));
    // aan de rand
    await evaluate(`${rowExpr(before[0])}.querySelector('.task-body').focus()`);
    await alt('ArrowUp');
    await sleep(200);
    assert.match(await live(), /staat al bovenaan\.$/);
    step('toetsenbord: Alt+↑/↓ zet een taak een plek hoger of lager, Alt+→/← maakt hem subtaak of haalt hem eruit; de focus blijft staan en een aria-live-regio meldt plek, sectie en grenzen');
  }

  // ---------- 8. projecten in de zijbalk ----------
  {
    await nav('Sleepproef');
    const names = () => projectOrder(null).filter((n) => ['Sleepproef', 'Doelproject', 'Naburig'].includes(n));
    assert.deepEqual(names().slice(0, 3), ['Sleepproef', 'Doelproject', 'Naburig']);
    // de zijbalk is langer geworden (Voltooid, Meldingen): de projecten midden in beeld, weg van de rand waar hij vanzelf scrolt
    await evaluate(`${navRowExpr('Doelproject')}.scrollIntoView({ block: 'center' })`);
    await sleep(200);
    const naburig = await navRect('Naburig');
    const sleep1 = await navRect('Sleepproef');
    await drag({ x: Math.round(naburig.x + 80), y: Math.round(naburig.y + naburig.h / 2) }, at(sleep1, 0.5, 0.1), async () => {
      assert.equal((await dragState()).line, true, 'een streep tussen de projecten');
      assert.deepEqual((await dragState()).source, ['Naburig']);
      await shot('slepen-project-volgorde');
    });
    await settle();
    assert.equal(names()[0], 'Naburig', 'bovenaan op de server');
    // erop laten vallen: subproject
    const nab = await navRect('Naburig');
    const doel = await navRect('Doelproject');
    await drag({ x: Math.round(nab.x + 80), y: Math.round(nab.y + nab.h / 2) }, at(doel, 0.5, 0.5), async () => {
      assert.deepEqual((await dragState()).child, ['Doelproject']);
      await shot('slepen-subproject');
    });
    await settle();
    assert.equal(projectOnServer(P3).parent_id, P2, 'subproject van Doelproject');
    await waitFor(`${navRowExpr('Naburig')}?.dataset.depth === '1'`, 'ingesprongen in de zijbalk');
    // eruit: op de kop "Projecten"
    const sub = await navRect('Naburig');
    const heading = await rectOf(`document.querySelector('#sidebar [data-drop-top]')`);
    await drag({ x: Math.round(sub.x + 90), y: Math.round(sub.y + sub.h / 2) }, at(heading, 0.4, 0.5), async () => {
      assert.equal((await dragState()).target, 1);
    });
    await settle();
    assert.equal(projectOnServer(P3).parent_id, null, 'weer een gewoon project');
    assert.equal(names()[0], 'Naburig', 'en bovenaan');
    // een cirkel kan niet: Doelproject op een subproject van zichzelf
    await asAlice([cmd('project_update', { id: P3, parent_id: P2 })]);
    await waitFor(`${navRowExpr('Naburig')}?.dataset.depth === '1'`, 'weer subproject');
    const doel2 = await navRect('Doelproject');
    const nab2 = await navRect('Naburig');
    await drag({ x: Math.round(doel2.x + 80), y: Math.round(doel2.y + doel2.h / 2) }, at(nab2, 0.5, 0.5), async () => {
      assert.equal((await dragState()).line || (await dragState()).child.length > 0 || (await dragState()).target > 0, false, 'op een eigen subproject kan niet: geen doel');
      assert.equal(await evaluate(`document.querySelector('.dnd-ghost').classList.contains('dnd-nodrop')`), true, 'de kopie toont dat loslaten hier niets doet');
    });
    await sleep(300);
    assert.equal(projectOnServer(P2).parent_id, null);
    await asAlice([cmd('project_update', { id: P3, parent_id: null })]);
    await waitFor(`${navRowExpr('Naburig')}?.dataset.depth === '0'`, 'Naburig weer op het hoogste niveau');
    step('projecten in de zijbalk: volgorde met een streep, op een project laten vallen maakt een subproject (kader), op de kop "Projecten" haalt hem eruit; niet op een eigen subproject');
  }

  // ---------- 9. een lid ziet slepen van een project niet als mogelijkheid ----------
  {
    const bobs = await navRect('Van Bob');
    const target = await navRect('Sleepproef');
    const p = { x: Math.round(bobs.x + 80), y: Math.round(bobs.y + bobs.h / 2) };
    await mouse('mouseMoved', p.x, p.y, 0);
    await mouse('mousePressed', p.x, p.y, 1);
    for (let i = 1; i <= 8; i++) await mouse('mouseMoved', p.x, Math.round(p.y + ((target.y - p.y) * i) / 8), 1);
    assert.equal((await dragState()).ghost, false, `geen sleep begonnen: ${JSON.stringify(await dragState())}`);
    await mouse('mouseReleased', p.x, target.y, 0);
    await sleep(300);
    // het toetsenbord doet ook niets: geen aankondiging, geen wijziging
    const orderBefore = projectOrder(null);
    await evaluate(`${navRowExpr('Van Bob')}.querySelector('.nav-item').focus()`);
    await evaluate(`document.getElementById('dnd-live').textContent = ''`);
    await alt('ArrowUp');
    await sleep(300);
    assert.equal(await live(), '');
    assert.deepEqual(projectOrder(null), orderBefore);
    // wel: een taak slepen naar dat project mag (iedereen kan in een gedeeld project schrijven)
    await nav('Sleepproef');
    const alfa = await rowRect('Alfa');
    const bobsNav = await navRect('Van Bob');
    await drag(grab(alfa), at(bobsNav, 0.5, 0.5));
    await settle();
    assert.equal(tasksOnServer().find((t) => t.content === 'Alfa').project_id, 'dnd-bobs-project');
    await waitFor(`[...document.querySelectorAll('.toast-text')].some((e) => e.textContent === '"Alfa" verplaatst naar "Van Bob".')`, 'melding');
    await evaluate(`[...document.querySelectorAll('.toast-text')].find((e) => e.textContent === '"Alfa" verplaatst naar "Van Bob".').parentElement.querySelector('.toast-action').click()`);
    await settle();
    assert.equal(tasksOnServer().find((t) => t.content === 'Alfa').project_id, P);
    step('een project waar Alice alleen lid van is: niet te slepen en Alt+pijl doet niets, een taak ernaartoe slepen mag wel');
  }

  // ---------- 10. automatisch scrollen aan de rand ----------
  {
    await nav('Lange lijst');
    await waitFor(`document.querySelectorAll('.task').length === 40`, 'lange lijst');
    await evaluate(`window.scrollTo(0, 0)`);
    const first = await rowRect('Regel 01');
    const from = grab(first);
    await mouse('mouseMoved', from.x, from.y, 0);
    await mouse('mousePressed', from.x, from.y, 1);
    for (let i = 1; i <= 6; i++) await mouse('mouseMoved', from.x, Math.round(from.y + ((820 - from.y) * i) / 6), 1);
    const y0 = await evaluate<number>(`window.scrollY`);
    await sleep(700);
    const y1 = await evaluate<number>(`window.scrollY`);
    assert.ok(y1 > y0 + 100, `de pagina scrolt vanzelf omlaag zolang je onderaan blijft (${y0} -> ${y1})`);
    await shot('slepen-autoscroll');
    // doorscrollen tot "Regel 30" in beeld komt (die stond bij het begin ver buiten beeld), dan eropaf en loslaten
    for (let i = 0; i < 40 && (await rowRect('Regel 30')).y > 600; i++) await sleep(100);
    const last = await rowRect('Regel 30');
    assert.ok(last.y < 700, 'Regel 30 is in beeld gescrold');
    await mouse('mouseMoved', from.x, Math.round(last.y + last.h * 0.9), 1);
    await sleep(150);
    const lineNear = Math.abs((await lineY()) - (await rowRect('Regel 30')).y - (await rowRect('Regel 30')).h);
    assert.ok(lineNear < 40, `de streep staat bij Regel 30 (${lineNear})`);
    await mouse('mouseReleased', from.x, Math.round(last.y + last.h * 0.9), 0);
    await settle();
    const order = serverOrder(LONG);
    assert.equal(order.indexOf('Regel 01'), order.indexOf('Regel 30') + 1, `Regel 01 staat nu onder Regel 30 (${order.slice(26, 33)})`);
    await evaluate(`window.scrollTo(0, 0)`);
    step('automatisch scrollen: onderaan het scherm blijven met een taak vast scrolt de lijst door, en loslaten op een regel die eerst buiten beeld stond werkt');
  }

  // ---------- 11. offline: direct zichtbaar, daarna op de server; en een geweigerde verplaatsing draait terug ----------
  {
    await nav('Sleepproef');
    await waitFor(`document.querySelectorAll('.task').length === 5`, 'Sleepproef');
    await evaluate(`window.scrollTo(0, 0)`);
    await sleep(300); // de pagina moet stil staan voordat we meten
    await stopServer();
    const delta = await rowRect('Delta');
    const echo = await rowRect('Echo');
    assert.deepEqual((await titles()).slice(-2), ['Delta', 'Echo']);
    await drag(grab(echo), at(delta, 0.5, 0.1), async () => { assert.equal((await dragState()).ghost, true, `sleep begonnen (${JSON.stringify(echo)} -> ${JSON.stringify(delta)})`); });
    await waitFor(`document.getElementById('sync-status').textContent.includes('wachtend')`, 'verplaatsing wacht in de wachtrij', 45_000);
    assert.deepEqual((await titles()).slice(-2), ['Echo', 'Delta'], 'in beeld direct verplaatst, zonder server');
    assert.deepEqual(serverOrder(P, S2), ['Delta', 'Echo'], 'de server weet er nog niets van');
    // in de tussentijd verdwijnt de sectie "Eerst" op een ander apparaat, en Charlie gaat daar nog naartoe
    const charlie = await rowRect('Charlie');
    const eerstHead = await rectOf(`[...document.querySelectorAll('.group')].find((g) => g.querySelector('.group-title')?.textContent === 'Eerst').querySelector('.group-head')`);
    await drag(grab(charlie), at(eerstHead, 0.5, 0.5));
    await sleep(300);
    assert.ok(await evaluate(`${rowExpr('Charlie')}.closest('.group').querySelector('.group-title')?.textContent === 'Eerst'`), 'Charlie staat optimistisch in Eerst');
    handleSync(db, { commands: [cmd('section_delete', { id: S1 })] }, alice.id);
    await startServer();
    await evaluate(`document.getElementById('sync-status').click()`);
    await waitFor(`[...document.querySelectorAll('.toast-text')].some((e) => e.textContent.startsWith('Niet gelukt (taak verplaatsen)'))`, 'foutmelding van de server', 20_000);
    await waitFor(`await ${SYNCED}`, 'bijgewerkt', 20_000);
    assert.equal(tasksOnServer().find((t) => t.content === 'Charlie').section_id, null, 'Charlie staat weer waar hij stond');
    assert.equal(await evaluate(`${rowExpr('Charlie')}.closest('.group').querySelector('.group-title') === null`), true, 'ook in beeld, zonder sectie Eerst');
    await shot('slepen-teruggedraaid');
    await evaluate(`document.querySelectorAll('.toast-close').forEach((b) => b.click())`);
    step('offline slepen: direct zichtbaar en met "wachtend" in de statusregel; een verplaatsing naar een sectie die intussen weg is draait terug met de melding "Niet gelukt (taak verplaatsen)"');
  }

  // ---------- 12. aanraken: scrollen blijft scrollen, lang indrukken of het handvat sleept ----------
  {
    const touch = (type: string, x: number, y: number) => send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await sleep(300);
    await nav('Lange lijst').catch(() => evaluate(`document.body.classList.add('nav-open')`).then(() => nav('Lange lijst')));
    await waitFor(`document.getElementById('view-title').textContent === 'Lange lijst' && document.querySelectorAll('.task').length === 40`, 'lange lijst op de telefoon');
    await evaluate(`window.scrollTo(0, 0)`);
    await sleep(200);
    const orderBefore = serverOrder(LONG);
    // a. snel omhoog vegen (scrollen) verplaatst niets
    const r1 = await rowRect('Regel 05');
    const p1 = { x: Math.round(r1.x + 120), y: Math.round(r1.y + r1.h / 2) };
    await touch('touchStart', p1.x, p1.y);
    for (let i = 1; i <= 8; i++) { await touch('touchMove', p1.x, p1.y - i * 30); await sleep(16); }
    await touch('touchEnd', p1.x, p1.y - 240);
    await sleep(500);
    assert.equal((await dragState()).ghost, false);
    assert.deepEqual(serverOrder(LONG), orderBefore, 'vegen verplaatst niets');
    assert.ok((await evaluate<number>(`window.scrollY`)) > 30, 'de pagina is gescrold');
    await evaluate(`window.scrollTo(0, 0)`);
    await sleep(200);
    // b. een tik opent de taak
    const r2 = await rowRect('Regel 05');
    const p2 = { x: Math.round(r2.x + 120), y: Math.round(r2.y + r2.h / 2) };
    await touch('touchStart', p2.x, p2.y);
    await sleep(60);
    await touch('touchEnd', p2.x, p2.y);
    await waitFor(`document.querySelector('#task-dialog[open]')`, 'een tik opent de taak');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await waitFor(`!document.querySelector('dialog[open]')`, 'venster dicht');
    // c. lang indrukken en dan slepen
    const from = await rowRect('Regel 05');
    const to = await rowRect('Regel 02');
    const pa = { x: Math.round(from.x + 120), y: Math.round(from.y + from.h / 2) };
    const scrollBefore = await evaluate<number>(`window.scrollY`);
    await touch('touchStart', pa.x, pa.y);
    await sleep(520);
    assert.equal((await dragState()).ghost, true, 'na lang indrukken begint het slepen');
    const steps = 8;
    for (let i = 1; i <= steps; i++) { await touch('touchMove', pa.x, Math.round(pa.y + ((to.y + to.h * 0.1 - pa.y) * i) / steps)); await sleep(16); }
    await sleep(80);
    assert.equal((await dragState()).line, true);
    assert.ok(Math.abs((await evaluate<number>(`window.scrollY`)) - scrollBefore) <= 2, 'de pagina scrolt niet mee terwijl je sleept');
    await shot('telefoon-slepen-lang-indrukken');
    await touch('touchEnd', pa.x, Math.round(to.y + to.h * 0.1));
    await settle();
    let order = serverOrder(LONG);
    assert.equal(order.indexOf('Regel 05'), order.indexOf('Regel 02') - 1, 'Regel 05 staat nu vóór Regel 02');
    // d. het handvat (rechts) sleept meteen
    const h = await rectOf(`${rowExpr('Regel 08')}.querySelector('.drag-handle')`);
    const target = await rowRect('Regel 03');
    const ph = { x: Math.round(h.x + h.w / 2), y: Math.round(h.y + h.h / 2) };
    assert.ok(h.w >= 30 && h.h >= 40, `het handvat is groot genoeg om aan te raken (${h.w} x ${h.h})`);
    await touch('touchStart', ph.x, ph.y);
    for (let i = 1; i <= 6; i++) { await touch('touchMove', ph.x, Math.round(ph.y + ((target.y + target.h * 0.1 - ph.y) * i) / 6)); await sleep(16); }
    assert.equal((await dragState()).ghost, true, 'vanaf het handvat begint het slepen zonder te wachten');
    await touch('touchEnd', ph.x, Math.round(target.y + target.h * 0.1));
    await settle();
    order = serverOrder(LONG);
    assert.equal(order.indexOf('Regel 08'), order.indexOf('Regel 03') - 1, 'Regel 08 staat nu vóór Regel 03');
    // e. op een telefoon: even bij de linkerrand blijven opent de zijbalk, om op een project los te laten
    const t3 = await rowRect('Regel 10');
    const pe = { x: Math.round(t3.x + 120), y: Math.round(t3.y + t3.h / 2) };
    await touch('touchStart', pe.x, pe.y);
    await sleep(520);
    for (let i = 1; i <= 6; i++) { await touch('touchMove', Math.round(pe.x - ((pe.x - 12) * i) / 6), pe.y); await sleep(16); }
    await waitFor(`document.body.classList.contains('nav-open')`, 'zijbalk opent bij de linkerrand', 4000);
    await sleep(300);
    await evaluate(`${navRowExpr('Doelproject')}.scrollIntoView({ block: 'center' })`); // de zijbalk is nu langer (Filters en Labels): het project staat misschien onder de rand
    await sleep(100);
    const doel = await navRect('Doelproject');
    for (let i = 1; i <= 6; i++) { await touch('touchMove', Math.round(12 + ((doel.x + 100 - 12) * i) / 6), Math.round(pe.y + ((doel.y + doel.h / 2 - pe.y) * i) / 6)); await sleep(16); }
    assert.equal((await dragState()).target, 1, 'het project licht op');
    await shot('telefoon-slepen-naar-project');
    await touch('touchEnd', Math.round(doel.x + 100), Math.round(doel.y + doel.h / 2));
    await settle();
    assert.equal(tasksOnServer().find((t) => t.content === 'Regel 10').project_id, P2);
    assert.equal(await evaluate(`document.body.classList.contains('nav-open')`), false, 'de zijbalk gaat weer dicht');
    await send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
    step('aanraken: vegen scrolt en verplaatst niets, een tik opent de taak, lang indrukken sleept, het handvat rechts sleept meteen, en bij de linkerrand opent de zijbalk om op een project los te laten');
  }

  // ---------- 13. minder beweging en het contrast van de nieuwe onderdelen ----------
  {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await nav('Sleepproef');
    await waitFor(`document.querySelectorAll('.task').length >= 4`, 'Sleepproef');
    await evaluate(`window.scrollTo(0, 0)`);
    await sleep(300);
    const all = await titles();
    const a = await rowRect(all[0]);
    const z = await rowRect(all[all.length - 1]);
    const p = grab(a);
    await mouse('mouseMoved', p.x, p.y, 0);
    await mouse('mousePressed', p.x, p.y, 1);
    for (let i = 1; i <= 8; i++) await mouse('mouseMoved', p.x, Math.round(p.y + ((z.y + z.h * 0.9 - p.y) * i) / 8), 1);
    await sleep(100);
    assert.equal((await dragState()).line, true, 'er is een invoegstreep om te meten');
    const motion = await evaluate<string[]>(`[document.querySelector('.dnd-ghost'), document.querySelector('.dnd-line'), document.querySelector('.drag-handle')].filter(Boolean).map((e) => getComputedStyle(e).transitionDuration + '|' + getComputedStyle(e).animationName)`);
    assert.ok(motion.length >= 2 && motion.every((m) => m === '0s|none'), `geen overgangen of animaties bij "minder beweging": ${motion}`);
    // contrast: de streep en het kader (accentkleur) tegen de achtergrond, in licht en donker
    for (const scheme of ['light', 'dark']) {
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
      await sleep(150);
      await shot(`slepen-${scheme === 'light' ? 'licht' : 'donker'}`);
      const colors = await evaluate<{ line: string; bg: string; soft: string; text: string }>(`(() => { const s = getComputedStyle(document.documentElement); const line = document.querySelector('.dnd-line'); return { line: line ? getComputedStyle(line).backgroundColor : '', bg: getComputedStyle(document.body).backgroundColor, soft: s.getPropertyValue('--accent-soft').trim(), text: s.getPropertyValue('--text-soft').trim() }; })()`);
      const rgb = (css: string) => (css.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
      const lum = ([r, g, b]: number[]) => { const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const ratio = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
      assert.ok(ratio(rgb(colors.line), rgb(colors.bg)) >= 3, `de invoegstreep heeft genoeg contrast met de achtergrond (${scheme}): ${ratio(rgb(colors.line), rgb(colors.bg)).toFixed(2)}`);
    }
    await mouse('mouseReleased', p.x, Math.round(z.y + z.h * 0.9), 0);
    await sleep(300);
    await send('Emulation.setEmulatedMedia', { features: [] });
    await settle();
    step('"minder beweging": kopie, streep en handvat hebben geen overgang of animatie; de invoegstreep heeft in licht en donker minstens 3:1 contrast met de achtergrond');
  }

  // opruimen: wat deze proef maakte, hoeft niet te blijven staan
  await asAlice([P, P2, P3, LONG].map((id) => cmd('project_delete', { id })));
  asBob([cmd('project_delete', { id: 'dnd-bobs-project' })]);
  await waitFor(`await ${SYNCED}`, 'opgeruimd', 15_000);
  await sleep(300);
}
