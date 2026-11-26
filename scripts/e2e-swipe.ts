// Vegen op een telefoon (ui/swipe.js) in een echte browser met nagebootste aanraking: naar rechts vinkt een taak af (ongedaan te maken),
// naar links opent het venster voor een nieuwe datum, een korte veeg doet niets. Wordt aangeroepen vanuit scripts/e2e.ts.

import assert from 'node:assert/strict';
import { createSession } from '../server/users.ts';

export async function swipeScenario(c: any) {
  const { send, evaluate, waitFor, step, js, SYNCED, db, alice, syncAs, serverState, nav, sleep } = c;
  const token = createSession(db, alice.id, 'Controle vegen').token;
  let k = 0;
  const as = async (commands: [string, object][]) => {
    const res = await syncAs(token, 'e2e-vegen', commands.map(([type, args]) => ({ type, uuid: `e2e-veeg-${String(++k).padStart(6, '0')}`, args })));
    assert.equal(res.status, 200);
    const body = await res.json();
    for (const [uuid, s] of Object.entries(body.sync_status)) assert.equal(s, 'ok', `${uuid}: ${JSON.stringify(s)}`);
  };
  const startView = await evaluate<string>(`document.getElementById('view-title').textContent`);
  const P = 'e2eveegproject01';
  await as([
    ['project_add', { id: P, name: 'Veegproef' }],
    ['task_add', { id: 'e2eveeg-rechts01', project_id: P, content: 'Veeg naar rechts' }],
    ['task_add', { id: 'e2eveeg-links001', project_id: P, content: 'Veeg naar links' }],
    ['task_add', { id: 'e2eveeg-kort0001', project_id: P, content: 'Even aanraken' }],
  ]);
  const task = (id: string) => (serverState().tasks as any[]).find((x) => x.id === id);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  try {
    await waitFor(`[...document.querySelectorAll('.nav-item .nav-label')].some((e) => e.textContent === 'Veegproef')`, 'het project', 10_000);
    await nav('Veegproef');
    const row = (id: string) => `document.querySelector('li.task[data-id="${id}"]')`;
    await waitFor(`${row('e2eveeg-rechts01')}`, 'de taken in de lijst');
    // een veeg met de vinger: aanwijzergebeurtenissen van het soort 'touch', zoals een telefoon ze geeft (de nagebootste aanraking via
    // het testprotocol bleef in een browser zonder venster soms hangen)
    const swipe = async (id: string, dx: number) => {
      await evaluate(`(async () => {
        const row = ${row(id)};
        const b = row.querySelector('.task-content').getBoundingClientRect();
        const x = b.left + 40, y = b.top + b.height / 2;
        const fire = (type, cx, target = row.querySelector('.task-content')) => target.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', pointerId: 7, isPrimary: true, clientX: cx, clientY: y, bubbles: true, cancelable: true }));
        fire('pointerdown', x);
        for (let i = 1; i <= 10; i++) { fire('pointermove', x + (${dx} * i) / 10); await new Promise((r) => setTimeout(r, 16)); }
        fire('pointerup', x + ${dx});
        // de klik die een vinger na loslaten geeft
        row.querySelector('.task-content').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x + ${dx}, clientY: y }));
      })()`);
    };

    // naar rechts: afgevinkt, met ongedaan maken
    await swipe('e2eveeg-rechts01', 220);
    await waitFor(`await ${SYNCED}`, 'gesynchroniseerd');
    await waitFor(`!${row('e2eveeg-rechts01')} || ${row('e2eveeg-rechts01')}.classList.contains('task-done')`, 'de taak is af');
    assert.equal(task('e2eveeg-rechts01').checked, true);
    assert.equal(await evaluate(`Boolean(document.querySelector('dialog[open]'))`), false, 'vegen opent de taak niet');

    // naar links: een nieuwe datum
    await swipe('e2eveeg-links001', -220);
    await waitFor(`[...document.querySelectorAll('dialog[open] h2')].some((e) => e.textContent === 'Nieuwe datum voor "Veeg naar links"')`, 'het datumvenster');
    const nextWeek = await evaluate<string>(`document.querySelectorAll('dialog[open] .datepop-quickrow')[3].dataset.date`);
    await evaluate(`document.querySelectorAll('dialog[open] .datepop-quickrow')[3].click()`);
    await waitFor(`!document.querySelector('dialog[open]')`, 'venster dicht');
    for (let i = 0; i < 50 && task('e2eveeg-links001').due?.date !== nextWeek; i++) { await evaluate(`document.getElementById('sync-status').click()`); await sleep(100); }
    assert.equal(task('e2eveeg-links001').due?.date, nextWeek, 'op de gekozen dag');
    await waitFor(`document.querySelector('.toast')?.textContent.includes('Veeg naar links')`, 'een melding met ongedaan maken');

    // een korte veeg doet niets, en de regel schuift terug
    await swipe('e2eveeg-kort0001', 50);
    await sleep(400);
    assert.equal(task('e2eveeg-kort0001').checked, false);
    assert.equal(await evaluate(`Boolean(document.querySelector('dialog[open]'))`), false);
    assert.equal(await evaluate(`${row('e2eveeg-kort0001')}.style.transform`), '', 'terug op zijn plek');
    assert.equal(await evaluate(`document.querySelectorAll('.swipe-under').length`), 0, 'geen kleur meer onder de taak');
    step('vegen op een telefoon: naar rechts afgevinkt, naar links een nieuwe datum (Volgende week), een korte veeg doet niets');
  } finally {
    await send('Emulation.clearDeviceMetricsOverride');
  }
  await as([['project_delete', { id: P }]]);
  await nav(startView);
  await waitFor(`document.getElementById('view-title').textContent === ${js(startView)}`, 'terug bij het begin');
}
