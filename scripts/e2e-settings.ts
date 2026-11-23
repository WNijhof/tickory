// Instellingen op een breed scherm, zoals Todoist op de computer: links de onderdelen in groepen, rechts het gekozen onderdeel,
// in één venster. Algemeen bewaart en blijft staan; Herinneringen (automatische herinnering en uitstellen) en Meldingen
// (ochtendoverzicht) werken meteen; Navigatiemenu, Navigatiebalk en Weergave staan rechts; Wat is er nieuw opent alleen een link.
// De andere browsertests doorlopen de onderdelen als losse vensters (globalThis.__tickorySettingsList); hier staat dat uit.
// Wordt aangeroepen vanuit scripts/e2e.ts.

import assert from 'node:assert/strict';

export async function settingsScenario(c: any) {
  const { evaluate, waitFor, step, shot, js, SYNCED, db, alice, nav } = c;
  const row = () => db.prepare('SELECT general, auto_reminder FROM user_settings WHERE id = ?').get(`settings-${alice.id}`) as { general: string | null; auto_reminder: number };
  const general = () => JSON.parse(row().general ?? '{}');
  const paneTitle = () => evaluate<string>(`document.querySelector('dialog[open] .settings-pane h2')?.textContent ?? ''`);
  const pick = async (label: string) => {
    await evaluate(`[...document.querySelectorAll('dialog[open] .settings-nav .settings-row')].find((b) => b.textContent.trim() === ${js(label)}).click()`);
    await waitFor(`document.querySelector('dialog[open] .settings-pane h2')?.textContent === ${js(label)}`, `onderdeel ${label}`);
  };
  const choose = (fk: string, value: string) => evaluate(`(() => { const s = document.querySelector('dialog[open] [data-fk="${fk}"]'); s.value = ${js(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const startView = await evaluate<string>(`document.getElementById('view-title').textContent`);

  await evaluate(`globalThis.__tickorySettingsList = false; document.querySelectorAll('.toast-close').forEach((b) => b.click())`);
  await nav('Alice');
  await waitFor(`document.querySelector('dialog[open] .settings-wide')`, 'instellingen met twee kolommen');
  await waitFor(`document.querySelector('dialog[open] .settings-pane h2')?.textContent === 'Algemeen'`, 'Algemeen staat rechts');

  // ---- de indeling van Todoist ----
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('dialog[open] .settings-group-title')].map((e) => e.textContent)`), ['Personalisatie', 'Productiviteit', 'Meer']);
  const items = await evaluate<string[]>(`[...document.querySelectorAll('dialog[open] .settings-nav .settings-row')].map((b) => b.textContent.trim())`);
  assert.deepEqual(items, ['Algemeen', 'Account, wachtwoord en apparaten', 'Weergave', 'Navigatiemenu', 'Navigatiebalk', 'Productiviteit', 'Herinneringen', 'Meldingen', 'Plaatsen',
    'Taal / Language', 'Sjablonen', 'Importeren uit Todoist', 'Gegevens exporteren', 'Handleiding', 'Wat is er nieuw', 'Nu bijwerken', 'Afmelden en lokale gegevens wissen']);
  assert.ok(!items.includes('Desktop-app'), 'Desktop-app alleen in de desktop-app');
  assert.equal(await evaluate(`document.querySelector('dialog[open] .settings-nav .is-current')?.textContent.trim()`), 'Algemeen');
  assert.equal(await evaluate(`Boolean(document.querySelector('dialog[open] [data-fk="general-snooze"]'))`), false, 'uitstellen staat bij Herinneringen, niet bij Algemeen');
  await shot('instellingen-breed');

  // ---- Algemeen: bewaren, en het onderdeel blijft staan ----
  await choose('general-start', 'today');
  await evaluate(`document.querySelector('dialog[open] [data-fk="general-save"]').click()`);
  await waitFor(SYNCED, 'gesynchroniseerd');
  await waitFor(`document.querySelector('dialog[open] .settings-pane [data-fk="general-start"]')?.value === 'today'`, 'Algemeen opnieuw getoond, met de nieuwe keuze');
  assert.equal(general().start_page, 'today');
  await choose('general-start', 'last');
  await evaluate(`document.querySelector('dialog[open] [data-fk="general-save"]').click()`);
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(general().start_page, 'last');

  // ---- Algemeen: meldingen onderin blijven staan tot je ze wegklikt ----
  await choose('general-toast', '0');
  await evaluate(`document.querySelector('dialog[open] [data-fk="general-save"]').click()`);
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(general().toast_seconds, 0);
  await evaluate(`import('/ui/dom.js').then((m) => { m.toast('Blijft staan'); return true; })`);
  await new Promise((r) => setTimeout(r, 7000)); // langer dan de standaard van 6 seconden
  assert.equal(await evaluate(`[...document.querySelectorAll('.toast-text')].some((e) => e.textContent === 'Blijft staan')`), true, 'de melding staat er na 7 seconden nog');
  await evaluate(`[...document.querySelectorAll('.toast')].find((e) => e.textContent.includes('Blijft staan')).querySelector('.toast-close').click()`);
  await waitFor(`document.querySelector('dialog[open] .settings-pane [data-fk="general-toast"]')`, 'Algemeen weer getoond');
  await choose('general-toast', '6');
  await evaluate(`document.querySelector('dialog[open] [data-fk="general-save"]').click()`);
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(general().toast_seconds, 6);

  // ---- Herinneringen: de automatische herinnering en uitstellen werken meteen ----
  await pick('Herinneringen');
  assert.equal(await evaluate(`document.querySelector('dialog[open] select[aria-label="Automatische herinnering"]').value`), String(row().auto_reminder));
  await evaluate(`(() => { const s = document.querySelector('dialog[open] select[aria-label="Automatische herinnering"]'); s.value = '60'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await choose('notify-snooze', '30');
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(row().auto_reminder, 60, 'een taak met een tijd krijgt nu een herinnering een uur vooraf');
  assert.equal(general().snooze_minutes, 30);
  assert.equal(await evaluate(`Boolean(document.querySelector('dialog[open] details.notify-device'))`), true, 'en de meldingen op dit apparaat');
  await evaluate(`(() => { const s = document.querySelector('dialog[open] select[aria-label="Automatische herinnering"]'); s.value = '30'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await choose('notify-snooze', '10');
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(row().auto_reminder, 30);
  assert.equal(general().snooze_minutes, 10);

  // ---- Meldingen: ochtendoverzicht aan en uit, meldingen bij samenwerken ----
  await pick('Meldingen');
  assert.equal(await evaluate(`Boolean(document.querySelector('dialog[open] [data-role="push-kinds"]'))`), true);
  await evaluate(`document.querySelector('dialog[open] [data-fk="notify-morning_overview-on"]').click()`);
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(general().morning_overview, '08:00');
  await evaluate(`document.querySelector('dialog[open] [data-fk="notify-morning_overview-on"]').click()`);
  await waitFor(SYNCED, 'gesynchroniseerd');
  assert.equal(general().morning_overview, null);
  step('instellingen op een breed scherm: de indeling van Todoist; Algemeen bewaart en blijft staan; Herinneringen (automatische herinnering, uitstellen) en Meldingen (ochtendoverzicht) werken meteen');

  // ---- Personalisatie ----
  await pick('Navigatiemenu');
  assert.ok(await evaluate(`document.querySelectorAll('dialog[open] [data-fk^="general-nav:"]').length > 3`), 'de onderdelen van de zijbalk');
  await pick('Navigatiebalk');
  assert.equal(await evaluate(`document.querySelectorAll('dialog[open] [data-fk^="general-tab:"]').length`), 4);
  await evaluate(`document.querySelector('dialog[open] .settings-nav [data-fk="settings:appearance"]').click()`);
  await waitFor(`document.querySelector('dialog[open] .settings-pane [data-role="theme-choice"]')`, 'Weergave staat rechts');

  // ---- Wat is er nieuw: alleen een link; het vorige onderdeel blijft staan ----
  await evaluate(`window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }`);
  await evaluate(`document.querySelector('dialog[open] .settings-nav [data-fk="settings:whatsnew"]').click()`);
  await waitFor(`window.__opened.length === 1`, 'de releases geopend');
  assert.equal(await evaluate(`window.__opened[0]`), 'https://github.com/WNijhof/tickory/releases');
  await waitFor(`document.querySelector('dialog[open] .settings-pane [data-role="theme-choice"]') && document.querySelector('dialog[open] .settings-nav .is-current')?.dataset.value === 'appearance'`, 'Weergave blijft staan');

  // ---- dicht, en weer bij het begin ----
  await evaluate(`document.querySelector('dialog[open] [data-fk="settings-close"]').click()`);
  await waitFor(`!document.querySelector('dialog[open]')`, 'instellingen dicht');
  await evaluate(`globalThis.__tickorySettingsList = true`);
  await nav(startView);
  await waitFor(`document.getElementById('view-title').textContent === ${js(startView)}`, 'terug bij het begin');
  step('instellingen op een breed scherm: Navigatiemenu, Navigatiebalk en Weergave rechts; Wat is er nieuw opent alleen de releases; sluiten met de knop');
}
