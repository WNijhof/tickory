// Slepen en verplaatsen in een echte browser: echte muis- en aanraakgebaren via het DevTools-protocol (geen gesimuleerde
// gebeurtenissen vanuit de pagina), met controle op de server. Wordt aangeroepen vanuit scripts/e2e.ts; de hulpfuncties van
// die test komen binnen via `c`. Schermafbeeldingen van de sleepstatus komen in .e2e/shots/.

import assert from 'node:assert/strict';
import { handleSync } from '../server/sync.ts';
import { todayString } from '../client/core/format.js';

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
    // met veel projecten en labels kan het doel onder de rand van de zijbalk staan: eerst in beeld, dan pas meten (het schuiven kan
    // ook de lijst verplaatsen)
    // (in het midden: vlak bij de rand gaat de zijbalk tijdens het slepen vanzelf scrollen)
    await evaluate(`(${navRowExpr('Doelproject')}).scrollIntoView({ block: 'center' })`);
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

  // ---------- 9. een project waar Alice lid van is: verschuiven in haar eigen volgorde wel, ergens onder hangen niet ----------
  {
    // op een ander project laten vallen (een subproject maken) verandert het project voor iedereen: dat mag alleen de eigenaar
    const bobs = await navRect('Van Bob');
    const target = await navRect('Sleepproef');
    const p = { x: Math.round(bobs.x + 80), y: Math.round(bobs.y + bobs.h / 2) };
    await mouse('mouseMoved', p.x, p.y, 0);
    await mouse('mousePressed', p.x, p.y, 1);
    for (let i = 1; i <= 8; i++) await mouse('mouseMoved', p.x, Math.round(p.y + ((target.y + target.h / 2 - p.y) * i) / 8), 1);
    assert.equal(await evaluate(`document.querySelector('.dnd-ghost')?.classList.contains('dnd-nodrop') ?? true`), true, `niet onder een ander project: ${JSON.stringify(await dragState())}`);
    await mouse('mouseReleased', p.x, Math.round(target.y + target.h / 2), 0);
    await sleep(300);
    assert.equal(projectOnServer('dnd-bobs-project').parent_id, null, 'nergens onder gehangen');
    // met het toetsenbord een plek omhoog: alleen in de volgorde van Alice (server/projectPrefs.ts), niet bij Bob
    const bobsOrder = () => (handleSync(db, { sync_token: '*' }, bob.id).projects as any[]).find((x) => x.id === 'dnd-bobs-project').order_key;
    const bobsKey = bobsOrder();
    const orderBefore = projectOrder(null);
    const at0 = orderBefore.indexOf('Van Bob');
    assert.ok(at0 > 0, `Van Bob staat niet bovenaan: ${JSON.stringify(orderBefore)}`);
    await evaluate(`${navRowExpr('Van Bob')}.querySelector('.nav-item').focus()`);
    await evaluate(`document.getElementById('dnd-live').textContent = ''`);
    await alt('ArrowUp');
    await waitFor(`document.getElementById('dnd-live').textContent !== ''`, 'een aankondiging');
    await waitFor(SYNCED, 'gesynchroniseerd');
    assert.equal(projectOrder(null).indexOf('Van Bob'), at0 - 1, 'een plek hoger bij Alice');
    assert.equal(bobsOrder(), bobsKey, 'bij Bob niet veranderd');
    await alt('ArrowDown');
    await waitFor(SYNCED, 'gesynchroniseerd');
    assert.deepEqual(projectOrder(null), orderBefore, 'en weer terug');
    // wel: een taak slepen naar dat project mag (iedereen kan in een gedeeld project schrijven)
    await nav('Sleepproef');
    await evaluate(`(${navRowExpr('Van Bob')}).scrollIntoView({ block: 'center' })`); // het doel in beeld, niet vlak bij de rand
    const alfa = await rowRect('Alfa');
    const bobsNav = await navRect('Van Bob');
    await drag(grab(alfa), at(bobsNav, 0.5, 0.5));
    await settle();
    assert.equal(tasksOnServer().find((t) => t.content === 'Alfa').project_id, 'dnd-bobs-project');
    await waitFor(`[...document.querySelectorAll('.toast-text')].some((e) => e.textContent === '"Alfa" verplaatst naar "Van Bob".')`, 'melding');
    await evaluate(`[...document.querySelectorAll('.toast-text')].find((e) => e.textContent === '"Alfa" verplaatst naar "Van Bob".').parentElement.querySelector('.toast-action').click()`);
    await settle();
    assert.equal(tasksOnServer().find((t) => t.content === 'Alfa').project_id, P);
    step('een project waar Alice alleen lid van is: niet onder een ander project, wel verschuiven in haar eigen volgorde (Bob merkt niets), en een taak ernaartoe slepen mag');
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

  // ---------- 14. filters en labels in een eigen volgorde ----------
  const F = ['dnd-filter-een', 'dnd-filter-twee', 'dnd-filter-drie'];
  const L = ['dnd-label-een', 'dnd-label-twee'];
  {
    await asAlice([
      cmd('filter_add', { id: F[0], name: 'Volgorde een', query: 'p1' }), cmd('filter_add', { id: F[1], name: 'Volgorde twee', query: 'p2' }),
      cmd('filter_add', { id: F[2], name: 'Volgorde drie', query: 'p3' }),
      cmd('label_add', { id: L[0], name: 'sleeplabel-een' }), cmd('label_add', { id: L[1], name: 'sleeplabel-twee' }),
    ]);
    const byKey = (a: any, b: any) => (a.order_key < b.order_key ? -1 : a.order_key > b.order_key ? 1 : a.id < b.id ? -1 : 1);
    const filterOrder = () => (serverState().filters as any[]).filter((f) => F.includes(f.id) && !f.is_deleted).sort(byKey).map((f) => f.name);
    const labelOrder = () => (serverState().labels as any[]).filter((l) => L.includes(l.id) && !l.is_deleted).sort(byKey).map((l) => l.name);
    const sideOrder = () => evaluate<string[]>(`[...document.querySelectorAll('#sidebar [data-order-kind="filter"]')].map((b) => b.querySelector('.find-label').textContent).filter((n) => n.startsWith('Volgorde'))`);
    await evaluate(`(() => { const b = document.querySelector('[data-fk="find-toggle:filters"]'); if (b && b.getAttribute('aria-expanded') === 'false') b.click(); })()`);
    await waitFor(`document.querySelector('#sidebar [data-order-id="${F[2]}"]')`, 'de nieuwe filters in de zijbalk', 15_000);
    assert.deepEqual(await sideOrder(), ['Volgorde een', 'Volgorde twee', 'Volgorde drie']);
    // met de muis in de zijbalk: "drie" boven "een"
    const sideRect = (id: string) => rectOf(`document.querySelector('#sidebar [data-order-id="${id}"]')`);
    await evaluate(`document.querySelector('#sidebar [data-order-id="${F[0]}"]').scrollIntoView({ block: 'center' })`);
    await sleep(100);
    const drie = await sideRect(F[2]);
    const een = await sideRect(F[0]);
    await drag(at(drie, 0.5, 0.5), at(een, 0.5, 0.2), async () => {
      const s = await dragState();
      assert.equal(s.ghost && s.line, true, 'een kopie en een invoegstreep');
      assert.ok(Math.abs((await lineY()) - een.y) <= 3, 'de streep staat boven "Volgorde een"');
      await shot('slepen-filter-zijbalk');
    });
    await settle();
    assert.deepEqual(filterOrder(), ['Volgorde drie', 'Volgorde een', 'Volgorde twee'], 'de server heeft de nieuwe volgorde');
    assert.deepEqual(await sideOrder(), ['Volgorde drie', 'Volgorde een', 'Volgorde twee']);
    assert.match(await live(), /"Volgorde drie" staat nu op plek \d+, totaal \d+\./);
    // de beheerpagina toont dezelfde volgorde; met het toetsenbord een plek omlaag, de focus blijft staan
    await evaluate(`document.querySelector('[data-fk="find-head:filters"]').click()`);
    await waitFor(`document.querySelector('[data-fk="filter-row:${F[2]}"]')`, 'de pagina Filters');
    const pageOrder = () => evaluate<string[]>(`[...document.querySelectorAll('#content .manage-row[data-order-kind="filter"] .manage-name')].map((e) => e.textContent).filter((n) => n.startsWith('Volgorde'))`);
    assert.deepEqual(await pageOrder(), ['Volgorde drie', 'Volgorde een', 'Volgorde twee']);
    assert.ok(await evaluate(`[...document.querySelectorAll('#content .manage-intro')].some((p) => p.textContent.startsWith('Sleep een filter'))`), 'uitleg over de volgorde');
    await evaluate(`document.querySelector('[data-fk="filter-row:${F[2]}"]').focus()`);
    await alt('ArrowDown');
    await settle();
    assert.deepEqual(filterOrder(), ['Volgorde een', 'Volgorde drie', 'Volgorde twee']);
    await waitFor(`document.activeElement?.dataset.fk === 'filter-row:${F[2]}'`, 'de focus blijft op het filter');
    assert.deepEqual(await pageOrder(), ['Volgorde een', 'Volgorde drie', 'Volgorde twee']);
    assert.match(await live(), /"Volgorde drie" staat nu op plek \d+, totaal \d+\./);
    // ongedaan maken (Ctrl+Z) zet de oude volgorde terug
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
    await settle();
    assert.deepEqual(filterOrder(), ['Volgorde drie', 'Volgorde een', 'Volgorde twee'], 'ongedaan gemaakt');
    // labels: met de muis op de beheerpagina, "twee" boven "een"
    await evaluate(`(() => { const b = document.querySelector('[data-fk="find-toggle:labels"]'); if (b && b.getAttribute('aria-expanded') === 'false') b.click(); })()`);
    await evaluate(`document.querySelector('[data-fk="find-head:labels"]').click()`);
    await waitFor(`document.querySelector('#content .manage-row[data-order-id="${L[1]}"]')`, 'de pagina Labels');
    await evaluate(`document.querySelector('#content .manage-row[data-order-id="${L[0]}"]').scrollIntoView({ block: 'center' })`);
    await sleep(100);
    const rowRectL = (id: string) => rectOf(`document.querySelector('#content .manage-row[data-order-id="${id}"]')`);
    const twee = await rowRectL(L[1]);
    const eenL = await rowRectL(L[0]);
    await drag({ x: Math.round(twee.x + 120), y: Math.round(twee.y + twee.h / 2) }, { x: Math.round(eenL.x + 120), y: Math.round(eenL.y + eenL.h * 0.2) }, async () => {
      assert.equal((await dragState()).line, true, 'een invoegstreep op de beheerpagina');
    });
    await settle();
    assert.deepEqual(labelOrder(), ['sleeplabel-twee', 'sleeplabel-een']);
    assert.equal(await evaluate(`document.getElementById('view-title').textContent`), 'Labels', 'slepen opent het label niet');
    const sideLabels = await evaluate<string[]>(`[...document.querySelectorAll('#sidebar [data-order-kind="label"] .find-label')].map((e) => e.textContent).filter((n) => n.startsWith('sleeplabel'))`);
    assert.deepEqual(sideLabels, ['sleeplabel-twee', 'sleeplabel-een'], 'de zijbalk volgt');
    step('filters en labels in een eigen volgorde: slepen in de zijbalk en op de beheerpagina (met invoegstreep), Alt+↓ met aankondiging en de focus op zijn plek, Ctrl+Z zet het terug, en zijbalk en pagina tonen dezelfde volgorde');
    await asAlice([...F.map((id) => cmd('filter_delete', { id })), ...L.map((id) => cmd('label_delete', { id }))]);
    for (const key of ['filters', 'labels']) await evaluate(`(() => { const b = document.querySelector('[data-fk="find-toggle:${key}"]'); if (b && b.getAttribute('aria-expanded') === 'true') b.click(); })()`);
  }

  // ---------- 15. je eigen volgorde in Vandaag ----------
  {
    const today = todayString();
    const DAY = ['Ochtendklus', 'Middagklus', 'Avondklus'];
    await asAlice(DAY.map((content, i) => cmd('task_add', { id: `dnd-day-${i}`, project_id: P3, content, due: { date: today } })));
    await nav('Vandaag');
    const dayGroup = `document.querySelector('.group[data-day-order="today"]')`;
    await waitFor(`${dayGroup} && [...${dayGroup}.querySelectorAll('.task-title')].some((e) => e.textContent === 'Avondklus')`, 'Vandaag met de drie taken', 15_000);
    const dayTitles = () => evaluate<string[]>(`[...${dayGroup}.querySelectorAll('li.task')].filter((li) => Number(li.dataset.depth ?? 0) === 0).map((li) => li.querySelector('.task-title').textContent).filter((n) => n.endsWith('klus'))`);
    const serverDayOrder = () => ((serverState().settings as any[])[0]?.day_order ?? null) as string[] | null;
    assert.deepEqual(await dayTitles(), DAY, 'zonder eigen volgorde: de gewone volgorde (hier: zoals ze zijn toegevoegd)');
    // slepen: Avondklus boven Ochtendklus
    await evaluate(`window.scrollTo(0, 0)`);
    await sleep(200);
    const avond = await rowRect('Avondklus');
    const ochtend = await rowRect('Ochtendklus');
    await drag(grab(avond), at(ochtend, 0.4, 0.2), async () => {
      assert.equal((await dragState()).line, true, 'een invoegstreep in Vandaag');
      assert.ok(Math.abs((await lineY()) - ochtend.y) <= 3, 'boven Ochtendklus');
      await shot('slepen-vandaag');
    });
    await settle();
    assert.deepEqual(await dayTitles(), ['Avondklus', 'Ochtendklus', 'Middagklus']);
    const order = serverDayOrder() ?? [];
    assert.deepEqual(order.filter((id) => id.startsWith('dnd-day-')), ['dnd-day-2', 'dnd-day-0', 'dnd-day-1'], 'de volgorde staat in je instellingen op de server');
    assert.equal((serverState().tasks as any[]).find((t) => t.id === 'dnd-day-2').project_id, P3, 'de taak zelf is niet verplaatst');
    assert.match(await live(), /"Avondklus" staat nu op plek 1, totaal \d+\./);
    // het toetsenbord: Alt+↓ op Avondklus, de focus blijft
    await evaluate(`${rowExpr('Avondklus')}.querySelector('.task-body').focus()`);
    await alt('ArrowDown');
    await settle();
    assert.deepEqual(await dayTitles(), ['Ochtendklus', 'Avondklus', 'Middagklus']);
    assert.match(await live(), /"Avondklus" staat nu op plek 2, totaal \d+\./);
    // ongedaan maken
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
    await settle();
    assert.deepEqual(await dayTitles(), ['Avondklus', 'Ochtendklus', 'Middagklus'], 'Ctrl+Z zet de vorige volgorde terug');
    // een nieuwe taak voor vandaag komt onderaan
    await asAlice([cmd('task_add', { id: 'dnd-day-3', project_id: P3, content: 'Nachtklus', due: { date: today } })]);
    await waitFor(`[...${dayGroup}.querySelectorAll('.task-title')].some((e) => e.textContent === 'Nachtklus')`, 'de nieuwe taak', 15_000);
    assert.deepEqual(await dayTitles(), ['Avondklus', 'Ochtendklus', 'Middagklus', 'Nachtklus']);
    // een andere sortering: geen slepen binnen de lijst, en de eigen volgorde weer wissen in het venster Sorteren
    await evaluate(`document.querySelector('[data-fk="list-options"]').click()`);
    await waitFor(`document.querySelector('dialog[open] [data-fk="listopt:clear-day-order"]')`, 'de knop Eigen volgorde wissen');
    await evaluate(`document.querySelector('dialog[open] [data-fk="listopt:clear-day-order"]').click()`);
    await waitFor(`!document.querySelector('dialog[open]')`, 'venster dicht');
    await settle();
    assert.equal(serverDayOrder(), null, 'gewist op de server');
    assert.deepEqual(await dayTitles(), ['Ochtendklus', 'Middagklus', 'Avondklus', 'Nachtklus'], 'weer de gewone volgorde');
    step('je eigen volgorde in Vandaag: slepen (met streep) en Alt+↓ bewaren de volgorde in je instellingen (de taak blijft waar ze is), Ctrl+Z zet terug, een nieuwe taak komt onderaan, en "Eigen volgorde wissen" geeft de gewone volgorde terug');
  }

  // ---------- 16. secties verplaatsen: in de lijst, met het toetsenbord, via het menu en als kolom op het bord ----------
  {
    const byKey = (a: any, b: any) => (a.order_key < b.order_key ? -1 : a.order_key > b.order_key ? 1 : a.id < b.id ? -1 : 1);
    const K1 = 'dnd-section-kolom1', K2 = 'dnd-section-kolom2';
    await asAlice([cmd('section_add', { id: K1, project_id: P3, name: 'Kolom een' }), cmd('section_add', { id: K2, project_id: P3, name: 'Kolom twee' })]);
    const sectionOrder = () => (serverState().sections as any[]).filter((s) => s.project_id === P3 && !s.is_deleted && !s.is_archived).sort(byKey).map((s) => s.name);
    const headExpr = (id: string, cls = 'group-head') => `document.querySelector('[data-move-section="${id}"] > .${cls}')`;
    await nav('Naburig');
    await waitFor(`document.querySelectorAll('.group[data-move-section]').length === 2`, 'twee secties om te verslepen', 15_000);
    await evaluate(`window.scrollTo(0, 0)`);
    await sleep(200);
    assert.deepEqual(sectionOrder(), ['Kolom een', 'Kolom twee']);
    // slepen aan de kop: Kolom twee boven Kolom een
    const daarna = await rectOf(headExpr(K2));
    const eerst = await rectOf(headExpr(K1));
    await drag({ x: Math.round(daarna.x + 50), y: Math.round(daarna.y + daarna.h / 2) }, { x: Math.round(eerst.x + 50), y: Math.round(eerst.y + eerst.h * 0.25) }, async () => {
      const s = await dragState();
      assert.equal(s.ghost && s.line, true, 'een kopie van de kop en een invoegstreep');
      assert.ok(Math.abs((await lineY()) - eerst.y) <= 3, 'de streep staat boven de sectie Kolom een');
      await shot('slepen-sectie');
    });
    await settle();
    assert.deepEqual(sectionOrder(), ['Kolom twee', 'Kolom een'], 'de server heeft de nieuwe volgorde');
    assert.deepEqual(await evaluate<string[]>(`[...document.querySelectorAll('.group[data-move-section] .group-title')].map((e) => e.textContent)`), ['Kolom twee', 'Kolom een']);
    assert.match(await live(), /Sectie "Kolom twee" staat nu op plek 1, totaal 2\./);
    // het toetsenbord: Alt+↓ op het inklappijltje van Kolom twee, de focus blijft
    await evaluate(`document.querySelector('[data-fk="section:${K2}"]').focus()`);
    await alt('ArrowDown');
    await settle();
    assert.deepEqual(sectionOrder(), ['Kolom een', 'Kolom twee']);
    await waitFor(`document.activeElement?.dataset.fk === 'section:${K2}'`, 'de focus blijft op de sectie');
    assert.match(await live(), /Sectie "Kolom twee" staat nu op plek 2, totaal 2\./);
    await alt('ArrowDown');
    await sleep(200);
    assert.match(await live(), /"Kolom twee" staat al onderaan/);
    // het menu: alleen wat kan, en met ongedaan maken
    await evaluate(`document.querySelector('[data-fk="sectionmenu:${K2}"]').click()`);
    await waitFor(`document.querySelector('dialog[open] .menu-item')`, 'het menu van de sectie');
    const items = await evaluate<string[]>(`[...document.querySelectorAll('dialog[open] .menu-item')].map((b) => b.textContent)`);
    assert.ok(items.includes('Een plek naar voren') && !items.includes('Een plek naar achteren'), `de laatste sectie kan alleen naar voren: ${items}`);
    await evaluate(`[...document.querySelectorAll('dialog[open] .menu-item')].find((b) => b.textContent === 'Een plek naar voren').click()`);
    await settle();
    assert.deepEqual(sectionOrder(), ['Kolom twee', 'Kolom een']);
    await waitFor(`[...document.querySelectorAll('.toast-text')].some((e) => e.textContent.startsWith('Sectie "Kolom twee" staat nu op plek 1'))`, 'een melding met ongedaan maken');
    // op het bord: de kolom Kolom een links van Kolom twee, met een staande streep
    await asAlice([cmd('project_update', { id: P3, view_style: 'board' })]);
    await waitFor(`document.querySelectorAll('.board-column[data-move-section]').length === 2`, 'het bord met twee kolommen om te verslepen', 15_000);
    await evaluate(`document.querySelectorAll('.toast-close').forEach((b) => b.click())`);
    await sleep(200);
    const colHead = await rectOf(headExpr(K1, 'board-column-head'));
    const target = await rectOf(`document.querySelector('.board-column[data-move-section="${K2}"]')`);
    await drag({ x: Math.round(colHead.x + 30), y: Math.round(colHead.y + colHead.h / 2) }, { x: Math.round(target.x + target.w * 0.25), y: Math.round(target.y + 60) }, async () => {
      assert.equal(await evaluate(`Boolean(document.querySelector('.dnd-line.dnd-line-v'))`), true, 'een staande streep tussen de kolommen');
      await shot('slepen-kolom');
    });
    await settle();
    assert.deepEqual(sectionOrder(), ['Kolom een', 'Kolom twee']);
    assert.deepEqual(await evaluate<string[]>(`[...document.querySelectorAll('.board-column[data-move-section] .board-column-title')].map((e) => e.textContent)`), ['Kolom een', 'Kolom twee']);
    // Alt+→ op het menu van de kolom Kolom een: een plek naar rechts
    await evaluate(`document.querySelector('[data-fk="sectionmenu:${K1}"]').focus()`);
    await alt('ArrowRight');
    await settle();
    assert.deepEqual(sectionOrder(), ['Kolom twee', 'Kolom een']);
    await asAlice([cmd('project_update', { id: P3, view_style: 'list' })]);
    await waitFor(`document.querySelectorAll('.group[data-move-section]').length === 2`, 'weer de lijst', 15_000);
    step('secties verplaatsen: slepen aan de kop in de lijst en als kolom op het bord (met liggende of staande streep), Alt+pijl op de kop met aankondiging en de focus op zijn plek, en "Een plek naar voren" in het menu met ongedaan maken');
  }

  // opruimen: wat deze proef maakte, hoeft niet te blijven staan
  await asAlice([P, P2, P3, LONG].map((id) => cmd('project_delete', { id })));
  asBob([cmd('project_delete', { id: 'dnd-bobs-project' })]);
  await waitFor(`await ${SYNCED}`, 'opgeruimd', 15_000);
  await sleep(300);
}
