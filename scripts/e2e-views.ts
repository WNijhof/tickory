// Slepen op het bord en in de kalender in een echte browser: echte muis- en aanraakgebaren via het DevTools-protocol, met controle
// op de server. Wordt aangeroepen vanuit scripts/e2e.ts (stap 8l); de hulpfuncties van die test komen binnen via `c`.

import assert from 'node:assert/strict';

type Rect = { x: number; y: number; w: number; h: number };

function helpers(c: any) {
  const { send, evaluate, waitFor, sleep, js, SYNCED } = c;
  const rectNow = (expr: string) => evaluate(`(() => { const e = ${expr}; if (!e) throw new Error('niet gevonden: ' + ${js(expr.slice(0, 140))}); const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`) as Promise<Rect>;
  /** De plek van een element, pas als hij stilstaat (de pagina kan na het tekenen nog even verspringen). */
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
  const mouse = (type: string, x: number, y: number, buttons: number) =>
    send('Input.dispatchMouseEvent', { type, x, y, button: buttons || type === 'mouseReleased' ? 'left' : 'none', buttons, clickCount: type === 'mouseMoved' ? 0 : 1, pointerType: 'mouse' });
  async function drag(from: { x: number; y: number }, to: { x: number; y: number }, during?: () => Promise<void>, steps = 10) {
    await mouse('mouseMoved', from.x, from.y, 0);
    await mouse('mousePressed', from.x, from.y, 1);
    for (let i = 1; i <= steps; i++) await mouse('mouseMoved', Math.round(from.x + ((to.x - from.x) * i) / steps), Math.round(from.y + ((to.y - from.y) * i) / steps), 1);
    await sleep(80);
    if (during) await during();
    await mouse('mouseReleased', to.x, to.y, 0);
    await sleep(150); // de app negeert de klik die op het loslaten volgt 60 ms lang: een klik van de test mag daar niet binnen vallen
  }
  const touch = (type: string, x: number, y: number) => send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  const settle = async () => { await sleep(150); await waitFor(`await ${SYNCED}`, 'gesynchroniseerd', 15_000); };
  const keyCode = (key: string) => ({ ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Escape: 27 } as Record<string, number>)[key];
  const alt = async (key: string) => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: keyCode(key), modifiers: 1 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: keyCode(key), modifiers: 1 });
  };
  const key = async (name: string) => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code: name, windowsVirtualKeyCode: keyCode(name) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: keyCode(name) });
  };
  const live = () => evaluate('document.getElementById(\'dnd-live\')?.textContent ?? \'\'') as Promise<string>;
  const dragState = () => evaluate(`({ ghost: Boolean(document.querySelector('.dnd-ghost')), line: Boolean(document.querySelector('.dnd-line')),
    source: [...document.querySelectorAll('.dnd-source .task-title, .dnd-source .cal-title-text')].map((e) => e.textContent),
    columns: [...document.querySelectorAll('.board-column.dnd-target')].map((e) => e.dataset.column), days: [...document.querySelectorAll('.cal-day.dnd-target')].map((e) => e.dataset.date) })`) as Promise<{ ghost: boolean; line: boolean; source: string[]; columns: string[]; days: string[] }>;
  const center = (r: Rect) => ({ x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) });
  const grab = (r: Rect) => ({ x: Math.round(r.x + Math.min(120, r.w / 2)), y: Math.round(r.y + r.h / 2) });
  return { rectOf, drag, mouse, touch, settle, alt, key, live, dragState, center, grab, sleep };
}

/** Het bord met de muis en het toetsenbord. Verwacht het bord van Thuis op een breed scherm, met de kolommen "Zonder sectie" en Keuken. */
export async function boardDragScenario(c: any): Promise<void> {
  const { evaluate, waitFor, js, shot, serverTask, serverState, keukenId, step } = c;
  const { rectOf, drag, settle, alt, key, live, dragState, grab, center } = helpers(c);
  const card = (name: string) => `[...document.querySelectorAll('li.task-card')].find((l) => l.querySelector('.task-title').textContent === ${js(name)})`;
  const column = (id: string) => `document.querySelector('.board-column[data-column=${js(id)}]')`;
  const sectionOrder = (section: string | null) => (serverState().tasks as any[]).filter((t) => t.project_id === serverTask('Afwasmachine uitruimen').project_id && (t.section_id ?? null) === section && !t.parent_id && !t.is_deleted && !t.checked)
    .sort((a, b) => (a.order_key < b.order_key ? -1 : a.order_key > b.order_key ? 1 : a.id < b.id ? -1 : 1)).map((t) => t.content);
  await evaluate(`window.scrollTo(0, 0)`);
  await waitFor(`document.querySelector('.board')`, 'bord');

  // 1. een kaart naar de andere kolom, boven een kaart: streep, bron gedimd, sectie en volgorde op de server, subtaak gaat mee
  {
    const from = await rectOf(card('Afwasmachine uitruimen'));
    const over = await rectOf(card('Van mijn telefoon'));
    await drag(grab(from), { x: Math.round(over.x + over.w / 2), y: Math.round(over.y + over.h * 0.12) }, async () => {
      const s = await dragState();
      assert.equal(s.ghost, true, 'een kopie van de kaart beweegt mee');
      assert.equal(s.line, true, 'de invoegstreep staat boven de kaart');
      assert.deepEqual(s.source, ['Afwasmachine uitruimen'], 'de kaart zelf is gedimd');
      await shot('bord-slepen');
    });
    await settle();
    assert.equal(serverTask('Afwasmachine uitruimen').section_id ?? null, null, 'de kaart staat nu in "Zonder sectie"');
    const order = sectionOrder(null);
    assert.equal(order.indexOf('Afwasmachine uitruimen'), order.indexOf('Van mijn telefoon') - 1, 'vlak vóór de kaart waarboven ze losgelaten is');
    assert.equal(((serverState().tasks as any[]).find((t) => t.content === 'Glazen apart')).section_id ?? null, null, 'de subtaak gaat mee');
    assert.equal(await evaluate(`document.querySelectorAll('.dnd-ghost, .dnd-line, .dnd-source').length`), 0, 'alles opgeruimd');
    assert.equal(await evaluate(`document.querySelector('dialog[open]')`), null, 'loslaten opent het taakvenster niet');
  }

  // 2. in de ruimte van een kolom loslaten: achteraan die kolom, de kolom licht op
  {
    const from = await rectOf(card('Afwasmachine uitruimen'));
    const space = await rectOf(`${column(keukenId)}.querySelector('.add-inline')`);
    await drag(grab(from), center(space), async () => {
      const s = await dragState();
      assert.deepEqual(s.columns, [keukenId], 'de kolom Keuken licht op');
    });
    await settle();
    assert.equal(serverTask('Afwasmachine uitruimen').section_id, keukenId);
    assert.equal(sectionOrder(keukenId).at(-1), 'Afwasmachine uitruimen', 'achteraan de kolom');
  }

  // 3. op de kop van een kolom: bovenaan die kolom
  {
    const from = await rectOf(card('Afwasmachine uitruimen'));
    const head = await rectOf(`${column('none')}.querySelector('.board-column-head')`);
    await drag(grab(from), center(head));
    await settle();
    assert.equal(serverTask('Afwasmachine uitruimen').section_id ?? null, null);
    assert.equal(sectionOrder(null)[0], 'Afwasmachine uitruimen', 'bovenaan de kolom');
  }

  // 4. Escape annuleert; loslaten op dezelfde plek verandert niets
  {
    const before = JSON.stringify(sectionOrder(null));
    const from = await rectOf(card('Afwasmachine uitruimen'));
    const over = await rectOf(card('Van mijn telefoon'));
    await drag(grab(from), { x: Math.round(over.x + over.w / 2), y: Math.round(over.y + over.h * 0.8) }, async () => {
      await key('Escape');
      await c.sleep(100);
      assert.equal((await dragState()).ghost, false, 'Escape stopt het slepen');
    });
    await c.sleep(200);
    assert.equal(JSON.stringify(sectionOrder(null)), before, 'niets veranderd');
    assert.match(await live(), /geannuleerd/);
  }

  // 5. toetsenbord: Alt + pijl links en rechts naar de kolom ernaast, omhoog en omlaag in de kolom
  {
    const focusCard = (name: string) => evaluate(`${card(name)}.querySelector('[data-act="open"]').focus()`);
    await focusCard('Afwasmachine uitruimen');
    await alt('ArrowLeft');
    await c.sleep(150);
    assert.match(await live(), /Links van "Afwasmachine uitruimen" is geen kolom meer/, 'links van de eerste kolom is er geen');
    await alt('ArrowRight');
    await settle();
    assert.equal(serverTask('Afwasmachine uitruimen').section_id, keukenId, 'Alt + pijl rechts: naar Keuken');
    assert.match(await live(), /Afwasmachine uitruimen" staat nu op plek \d+, totaal \d+ in "Keuken"/);
    await waitFor(`document.activeElement === ${card('Afwasmachine uitruimen')}?.querySelector('[data-act="open"]')`, 'de focus blijft bij de kaart');
    await alt('ArrowRight');
    await c.sleep(150);
    assert.match(await live(), /Rechts van "Afwasmachine uitruimen" is geen kolom meer/);
    await alt('ArrowUp');
    await settle();
    assert.equal(sectionOrder(keukenId)[0], 'Afwasmachine uitruimen', 'Alt + pijl omhoog: een plek hoger (hier bovenaan)');
    await alt('ArrowLeft');
    await settle();
    assert.equal(serverTask('Afwasmachine uitruimen').section_id ?? null, null, 'en weer terug');
    await shot('bord-na-slepen');
  }
  step('slepen op het bord: een kaart naar een andere kolom boven een kaart (streep, gedimde bron, sectie en volgorde op de server, subtaak gaat mee), in de ruimte van een kolom (kolom licht op, achteraan) en op de kop (bovenaan); Escape annuleert; Alt + pijlen: links en rechts naar de andere kolom met aankondiging en focus, omhoog en omlaag in de kolom');
}

/** De kalender met de muis en het toetsenbord. Verwacht de maandweergave van Thuis, met de taak "Teamoverleg" (vandaag 10:00, wekelijks). */
export async function calendarDragScenario(c: any): Promise<void> {
  const { evaluate, waitFor, js, shot, serverTask, syncAs, otherToken, thuisId, today, addDays, step } = c;
  const { rectOf, drag, settle, alt, live, dragState, center, grab } = helpers(c);
  const item = (id: string, real = true) => `document.querySelector('li.cal-item[data-task-id="${id}"][data-real="${real}"]')`;
  const dayCell = (date: string) => `document.querySelector('td.cal-day[data-date="${date}"]')`;
  const OVERLEG = 'e2ekalenderoverleg01';
  const overleg = () => (c.serverState().tasks as any[]).find((t) => t.id === OVERLEG);
  await evaluate(`window.scrollTo(0, 0)`);
  await waitFor(`document.querySelector('.cal[data-mode="month"]')`, 'maandweergave');
  // een dag waar de taak naartoe kan: de eerste van de komende dagen die in beeld is
  const target = await evaluate(`(() => { for (const n of [2, 3, 1, 4]) { const d = ${js(today)}; const t = new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); const c = document.querySelector('td.cal-day[data-date="' + t + '"]'); if (c && c.getBoundingClientRect().height > 0) return t; } return null; })()`) as string;
  assert.ok(target, 'een dag in beeld om naartoe te slepen');

  // 1. een taak naar een andere dag: datum verzet, tijd en herhaling blijven, melding met ongedaan maken
  {
    const from = await rectOf(`${item(OVERLEG)}.querySelector('.cal-open')`);
    const to = await rectOf(dayCell(target));
    await drag(grab(from), center(to), async () => {
      const s = await dragState();
      assert.equal(s.ghost, true, 'een kopie van de taak beweegt mee');
      assert.deepEqual(s.days, [target], 'de dag waar je boven staat licht op');
      assert.deepEqual(s.source, ['Teamoverleg'], 'de taak zelf is gedimd');
      await shot('kalender-slepen');
    });
    await settle();
    const t = overleg();
    assert.equal(t.due.date, `${target}T10:00`, 'andere dag, zelfde tijd');
    assert.deepEqual(t.due.recurrence, { freq: 'weekly' }, 'de herhaling blijft');
    assert.equal(t.due.string, 'elke week');
    assert.equal(t.completed_count, 0, 'verzetten is niet afronden');
    assert.ok(await evaluate(`Boolean(${dayCell(target)}.querySelector('li.cal-item[data-task-id="${OVERLEG}"][data-real="true"]'))`), 'de taak staat nu op die dag');
    assert.match(await live(), /Teamoverleg" verzet naar/);
    assert.equal(await evaluate(`document.querySelector('dialog[open]')`), null, 'loslaten opent het taakvenster niet');
    await evaluate(`[...document.querySelectorAll('.toast')].find((t) => t.textContent.includes('Teamoverleg') && t.textContent.includes('verzet naar')).querySelector('.toast-action').click()`);
    await settle();
    assert.equal(overleg().due.date, `${today}T10:00`, 'ongedaan maken zet de datum terug');
  }

  // 2. een voorkomen van een herhaling dat nog niet aan de beurt is, sleep je niet
  {
    const virtual = await evaluate(`(() => { const e = document.querySelector('li.cal-item[data-task-id="${OVERLEG}"][data-real="false"]'); return e ? e.dataset.date : null; })()`) as string | null;
    assert.ok(virtual, 'er staat een komend voorkomen in beeld');
    const from = await rectOf(`${item(OVERLEG, false)}.querySelector('.cal-open')`);
    const to = await rectOf(dayCell(target));
    await drag(grab(from), center(to), async () => {
      assert.equal((await dragState()).ghost, false, 'bij een voorkomen begint het slepen niet');
    });
    await c.sleep(300);
    assert.equal(overleg().due.date, `${today}T10:00`, 'niets veranderd');
  }

  // 3. een te late taak naar vandaag
  {
    const yesterday = addDays(today, -1);
    assert.equal((await syncAs(otherToken, 'ander-apparaat', [{ type: 'task_add', uuid: 'e2e-kalender-telaat-2', args: { id: 'e2ekalendertelaat02', project_id: thuisId, content: 'Brief posten', due: { date: yesterday } } }])).status, 200);
    await waitFor(`document.querySelector('.cal-overdue-list li.cal-item[data-task-id="e2ekalendertelaat02"]')`, 'te late taak in beeld', 15_000);
    const from = await rectOf(`document.querySelector('.cal-overdue-list li.cal-item[data-task-id="e2ekalendertelaat02"] .cal-open')`);
    const to = await rectOf(dayCell(today));
    await drag(grab(from), center(to));
    await settle();
    assert.equal(serverTask('Brief posten').due.date, today, 'een te late taak naar vandaag: niet meer te laat');
    await waitFor(`!document.querySelector('.cal-overdue-list li.cal-item[data-task-id="e2ekalendertelaat02"]')`, 'weg uit "Te laat"');
  }

  // 4. toetsenbord: Alt + pijl links en rechts een dag, omhoog en omlaag een week; de focus blijft bij de taak
  {
    const focused = `document.activeElement === ${item(OVERLEG)}?.querySelector('.cal-open')`;
    await evaluate(`${item(OVERLEG)}.querySelector('.cal-open').focus()`);
    await alt('ArrowLeft');
    await settle();
    assert.equal(overleg().due.date, `${addDays(today, -1)}T10:00`, 'Alt + pijl links: een dag eerder');
    assert.match(await live(), /Teamoverleg" verzet naar/);
    await waitFor(focused, 'de focus blijft bij de taak');
    await alt('ArrowRight');
    await settle();
    assert.equal(overleg().due.date, `${today}T10:00`, 'Alt + pijl rechts: weer een dag later');
    await waitFor(focused, 'de focus blijft bij de taak (rechts)');
    await alt('ArrowUp');
    await settle();
    assert.equal(overleg().due.date, `${addDays(today, -7)}T10:00`, 'Alt + pijl omhoog: een week eerder');
    await waitFor(focused, 'de focus blijft bij de taak (omhoog)');
    await alt('ArrowDown');
    await settle();
    assert.equal(overleg().due.date, `${today}T10:00`, 'Alt + pijl omlaag: een week later');
    assert.deepEqual(overleg().due.recurrence, { freq: 'weekly' }, 'de herhaling blijft');
    assert.equal(overleg().due.string, 'elke week');
  }
  step('slepen in de kalender: een taak naar een andere dag (dag licht op, gedimde bron, datum verzet met tijd en herhaling, geen afronding, melding met ongedaan maken), een komend voorkomen van een herhaling is niet te slepen, een te late taak naar vandaag; Alt + pijlen: een dag of een week, de focus blijft bij de taak');
}

/** Aanraken op het bord (telefoon): lang indrukken, naar de rand slepen zodat het bord meeschuift, loslaten in de volgende kolom. */
export async function boardTouchScenario(c: any): Promise<void> {
  const { evaluate, waitFor, js, shot, serverTask, keukenId, step } = c;
  const { rectOf, touch, settle, dragState, sleep } = helpers(c);
  await send(c, 'Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  try {
    await evaluate(`document.querySelector('.board').scrollTo({ left: 0 })`);
    await evaluate(`window.scrollTo(0, document.querySelector('.board').getBoundingClientRect().top + window.scrollY - 70)`); // het bord bovenaan in beeld
    await sleep(500);
    const name = await evaluate(`document.querySelector('.board-column[data-column="none"] li.task-card .task-title').textContent`) as string;
    const cardExpr = `[...document.querySelectorAll('li.task-card')].find((l) => l.querySelector('.task-title').textContent === ${js(name)})`;
    const from = await rectOf(cardExpr);
    const p = { x: Math.round(from.x + 90), y: Math.round(from.y + from.h / 2) };
    await touch('touchStart', p.x, p.y);
    await sleep(520);
    assert.equal((await dragState()).ghost, true, 'na lang indrukken begint het slepen');
    // naar de rechterrand van het scherm en daar even blijven: het bord schuift mee
    for (let i = 1; i <= 8; i++) { await touch('touchMove', Math.round(p.x + ((380 - p.x) * i) / 8), p.y); await sleep(16); }
    await waitFor(`document.querySelector('.board').scrollLeft > 100`, 'het bord schuift mee bij de rand', 5000);
    await touch('touchMove', 200, p.y); // weg bij de rand: het bord blijft staan
    await sleep(200);
    // en terug: bij de linkerrand schuift het bord de andere kant op
    const scrolled = await evaluate(`document.querySelector('.board').scrollLeft`) as number;
    for (let i = 1; i <= 4; i++) { await touch('touchMove', Math.round(200 - ((200 - 6) * i) / 4), p.y); await sleep(16); }
    await waitFor(`document.querySelector('.board').scrollLeft < ${scrolled - 20}`, 'het bord schuift terug bij de linkerrand', 5000);
    await touch('touchMove', 200, p.y);
    await sleep(200);
    await touch('touchMove', 380, p.y); // en weer naar rechts, naar de kolom Keuken
    await waitFor(`document.querySelector('.board').scrollLeft > 100`, 'het bord schuift weer mee', 5000);
    await touch('touchMove', 200, p.y);
    await sleep(200);
    const column = await rectOf(`document.querySelector('.board-column[data-column=${js(keukenId)}] .add-inline')`);
    const at = { x: Math.round(Math.min(column.x + column.w / 2, 340)), y: Math.round(column.y + column.h / 2) };
    for (let i = 1; i <= 6; i++) { await touch('touchMove', Math.round(200 + ((at.x - 200) * i) / 6), Math.round(p.y + ((at.y - p.y) * i) / 6)); await sleep(16); }
    await shot('bord-telefoon-slepen');
    assert.deepEqual((await dragState()).columns, [keukenId], 'de kolom Keuken licht op');
    await touch('touchEnd', at.x, at.y);
    await settle();
    assert.equal(serverTask(name).section_id, keukenId, 'op een telefoon: de kaart staat in de andere kolom');
    // terugzetten met het menu "Verplaats naar…"
    await evaluate(`${cardExpr}.querySelector('.card-move').click()`);
    await waitFor(`document.querySelector('dialog[open] .menu')`, 'menu');
    await evaluate(`[...document.querySelectorAll('dialog[open] .menu-item')].find((b) => b.textContent.startsWith('Zonder sectie')).click()`);
    await settle();
    assert.equal(serverTask(name).section_id ?? null, null);
  } finally {
    await send(c, 'Emulation.setTouchEmulationEnabled', { enabled: false });
  }
  step('slepen op het bord met een vinger: lang indrukken, bij de rechterrand schuift het bord mee, loslaten in de volgende kolom; het menu "Verplaats naar…" zet de kaart terug');
}

/** Aanraken in de kalender (telefoon): lang indrukken en loslaten op een andere dag in de lijst. */
export async function calendarTouchScenario(c: any): Promise<void> {
  const { evaluate, waitFor, shot, today, step, js } = c;
  const { rectOf, touch, settle, dragState, sleep } = helpers(c);
  const OVERLEG = 'e2ekalenderoverleg01';
  await send(c, 'Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  try {
    await evaluate(`document.querySelectorAll('.toast-close').forEach((b) => b.click())`); // meldingen (ook die met Ongedaan maken) liggen over de lijst
    await evaluate(`window.scrollTo(0, 0)`);
    await sleep(300);
    const next = await evaluate(`(() => { const days = [...document.querySelectorAll('td.cal-day')].filter((d) => d.getBoundingClientRect().height > 0 && d.dataset.date > ${js(today)}); return days[0]?.dataset.date ?? null; })()`) as string | null;
    assert.ok(next, 'een volgende dag in de lijst');
    const from = await rectOf(`document.querySelector('li.cal-item[data-task-id="${OVERLEG}"][data-real="true"] .cal-open')`);
    const p = { x: Math.round(from.x + 90), y: Math.round(from.y + from.h / 2) };
    await touch('touchStart', p.x, p.y);
    await sleep(520);
    assert.equal((await dragState()).ghost, true, 'na lang indrukken begint het slepen');
    const to = await rectOf(`document.querySelector('td.cal-day[data-date="${next}"] .cal-day-head')`);
    const at = { x: Math.round(to.x + to.w / 2), y: Math.round(to.y + to.h / 2) };
    for (let i = 1; i <= 6; i++) { await touch('touchMove', p.x, Math.round(p.y + ((at.y - p.y) * i) / 6)); await sleep(16); }
    assert.deepEqual((await dragState()).days, [next], 'de dag licht op');
    await shot('kalender-telefoon-slepen');
    await touch('touchEnd', p.x, at.y);
    await settle();
    const t = (c.serverState().tasks as any[]).find((x) => x.id === OVERLEG);
    assert.equal(t.due.date, `${next}T10:00`, 'op een telefoon: de taak staat op de andere dag');
    await evaluate(`[...document.querySelectorAll('.toast')].find((t) => t.textContent.includes('Teamoverleg') && t.textContent.includes('verzet naar'))?.querySelector('.toast-action').click()`);
    await settle();
    assert.equal((c.serverState().tasks as any[]).find((x) => x.id === OVERLEG).due.date, `${today}T10:00`);
    await waitFor(`document.querySelector('li.cal-item[data-task-id="${OVERLEG}"][data-real="true"]')`, 'weer op vandaag');
  } finally {
    await send(c, 'Emulation.setTouchEmulationEnabled', { enabled: false });
  }
  step('slepen in de kalender met een vinger: lang indrukken, loslaten op een andere dag in de lijst per dag; ongedaan maken zet de datum terug');
}

const send = (c: any, method: string, params: object) => c.send(method, params);
