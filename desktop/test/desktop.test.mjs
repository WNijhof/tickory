// De onderdelen van de desktop-app die zonder Electron werken: serveradres, instellingen, herinneringen plannen, menu's, meldingen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalHost, normalizeServer, sameOrigin } from '../lib/server.mjs';
import { DEFAULT_SHORTCUTS, markShown, settingsOf, validShortcut } from '../lib/settings.mjs';
import { HORIZON_MS, LATE_MS, planReminders, snoozeMs, todayItems } from '../lib/reminderPlan.mjs';
import { NAV, appMenu, trayMenu } from '../lib/menuModel.mjs';
import { KEYS, KEYS_EN, langOf, translator } from '../lib/i18n.mjs';
import { actionUrl, parseActionUrl, reminderToastXml } from '../lib/toast.mjs';
import { ACCENTS, BACKGROUND, appearanceOf, appearanceOrDefault, backgroundOf, fromWeb } from '../lib/appearance.mjs';

test('thema: dezelfde keuzes als Weergave in de web-app, en wie wint bij het opstarten', () => {
  assert.deepEqual(appearanceOf({ theme: 'dark', accent: 'teal' }), { theme: 'dark', accent: 'teal' });
  assert.deepEqual(appearanceOf({ theme: 'light', accent: 'rommel' }), { theme: 'light', accent: 'tomato' });
  for (const bad of [null, 'dark', { theme: 'paars' }, []]) assert.equal(appearanceOf(bad), null, JSON.stringify(bad));
  assert.deepEqual(appearanceOrDefault(null), { theme: 'system', accent: 'tomato' });
  assert.deepEqual(ACCENTS.map((a) => a.name), ['tomato', 'teal', 'blue', 'indigo', 'violet', 'rose', 'orange', 'green', 'graphite']);
  assert.equal(backgroundOf('dark', false), BACKGROUND.dark);
  assert.equal(backgroundOf('light', true), BACKGROUND.light);
  assert.equal(backgroundOf('system', true), BACKGROUND.dark);
  const dark = { theme: 'dark', accent: 'teal' };
  const light = { theme: 'light', accent: 'tomato' };
  // nog niets bewaard (een installatie van vóór deze versie): de keuze van de web-app overnemen
  assert.deepEqual(fromWeb(null, dark, true), { save: dark, reply: null });
  // in de eigen Instellingen gekozen terwijl de web-app dicht was: bij het opstarten krijgt de web-app dat terug
  assert.deepEqual(fromWeb(light, dark, true), { save: null, reply: light });
  assert.deepEqual(fromWeb(dark, dark, true), { save: null, reply: null });
  // daarna is een keuze in de web-app gewoon een nieuwe keuze
  assert.deepEqual(fromWeb(light, dark, false), { save: dark, reply: null });
  assert.deepEqual(fromWeb(dark, dark, false), { save: null, reply: null });
  assert.deepEqual(fromWeb(light, { theme: 'x' }, false), { save: null, reply: null });
  assert.deepEqual(settingsOf({ appearance: dark }).appearance, dark);
  assert.equal(settingsOf({ appearance: { theme: 'x' } }).appearance, null);
});

test('serveradres: https erbij, pad weg; http alleen in je eigen netwerk', () => {
  assert.deepEqual(normalizeServer('taken.voorbeeld.nl'), { origin: 'https://taken.voorbeeld.nl' });
  assert.deepEqual(normalizeServer(' https://taken.voorbeeld.nl/app/  '), { origin: 'https://taken.voorbeeld.nl' });
  assert.deepEqual(normalizeServer('http://192.168.1.20:3000'), { origin: 'http://192.168.1.20:3000' });
  assert.deepEqual(normalizeServer('http://localhost:3000/'), { origin: 'http://localhost:3000' });
  assert.deepEqual(normalizeServer('http://nas.local'), { origin: 'http://nas.local' });
  assert.deepEqual(normalizeServer('http://taken.voorbeeld.nl'), { error: 'http' });
  assert.deepEqual(normalizeServer(''), { error: 'empty' });
  for (const bad of ['ftp://x.nl', 'https://user:pw@x.nl', 'https://', 'javascript:alert(1)']) assert.ok(normalizeServer(bad).error, bad);
  assert.equal(isLocalHost('10.0.0.5'), true);
  assert.equal(isLocalHost('172.20.1.1'), true);
  assert.equal(isLocalHost('172.40.1.1'), false);
  assert.equal(isLocalHost('8.8.8.8'), false);
  assert.equal(sameOrigin('https://taken.voorbeeld.nl/#view=today', 'https://taken.voorbeeld.nl'), true);
  assert.equal(sameOrigin('https://taken.voorbeeld.nl.evil.com/', 'https://taken.voorbeeld.nl'), false);
  assert.equal(sameOrigin('niet een url', 'https://taken.voorbeeld.nl'), false);
});

test('instellingen: de standaard van Todoist (Ctrl+Spatie, Win+Alt+S, in het systeemvak blijven), en iets kapots wordt de standaard', () => {
  const d = settingsOf(null);
  assert.deepEqual(d.shortcuts, DEFAULT_SHORTCUTS);
  assert.deepEqual(DEFAULT_SHORTCUTS, { activate: 'Super+Alt+S', quickAdd: 'Control+Space' });
  assert.equal(d.stayInTray, true);
  assert.equal(d.openAtLogin, false);
  const s = settingsOf({ server: 'https://x.nl', shortcuts: { quickAdd: 'Alt+Q', activate: 'rommel' }, zoom: 9, bounds: { x: 0, y: 0, width: 100, height: 100 }, shown: ['a', 3] });
  assert.equal(s.shortcuts.quickAdd, 'Alt+Q');
  assert.equal(s.shortcuts.activate, DEFAULT_SHORTCUTS.activate);
  assert.equal(s.zoom, 0);
  assert.equal(s.bounds, null, 'te klein');
  assert.deepEqual(s.shown, ['a']);
  for (const ok of ['Control+Space', 'Super+Alt+S', 'Control+Shift+A', 'Alt+F4', '']) assert.ok(validShortcut(ok), ok);
  for (const bad of ['A', 'Space', 'Control+', 'Control+Alt+Shift+Super+A', 'Ctrl+Ü', 123]) assert.equal(validShortcut(bad), false, String(bad));
  let m = settingsOf(null);
  for (let i = 0; i < 600; i++) m = markShown(m, `r${i}|x`);
  assert.equal(m.shown.length, 500, 'begrensd');
  assert.equal(m.shown.at(-1), 'r599|x');
});

const sync = (extra = {}) => ({
  me: { id: 'user-anna-0001' },
  settings: [{ owner_id: 'user-anna-0001', timezone: 'Europe/Amsterdam', general: { snooze_minutes: 30 } }],
  tasks: [
    { id: 'taak-0001-aaaa', content: 'Tandarts bellen', due: { date: '2026-11-20T14:00' }, priority: 1 },
    { id: 'taak-0002-aaaa', content: 'Boodschappen', due: { date: '2026-11-19' }, priority: 3 },
    { id: 'taak-0003-aaaa', content: 'Af', due: { date: '2026-11-20T09:00' }, checked: true },
    { id: 'taak-0004-aaaa', content: 'Later', due: { date: '2026-12-01' }, priority: 4 },
  ],
  reminders: [
    { id: 'herinnering-01', owner_id: 'user-anna-0001', task_id: 'taak-0001-aaaa', type: 'relative', minute_offset: 30 },
    { id: 'herinnering-02', owner_id: 'user-anna-0001', task_id: 'taak-0003-aaaa', type: 'absolute', due: { date: '2026-11-20T08:00' } },
    { id: 'herinnering-03', owner_id: 'iemand-anders', task_id: 'taak-0001-aaaa', type: 'absolute', due: { date: '2026-11-20T10:00' } },
    { id: 'herinnering-04', owner_id: 'user-anna-0001', task_id: 'taak-0001-aaaa', type: 'absolute', due: { date: '2026-11-25T10:00' } },
  ],
  ...extra,
});

test('herinneringen plannen: eigen, open taken, binnen een dag, in de tijdzone van je instellingen', () => {
  const now = Date.parse('2026-11-20T08:00:00Z'); // 09:00 in Amsterdam
  const plan = planReminders(sync(), now);
  assert.deepEqual(plan.map((r) => [r.id, r.moment]), [['herinnering-01', '2026-11-20T13:30']]);
  assert.equal(plan[0].at, Date.parse('2026-11-20T12:30:00Z'));
  assert.equal(plan[0].title, 'Tandarts bellen');
  assert.deepEqual(planReminders(sync(), now, ['herinnering-01|2026-11-20T13:30']), [], 'al getoond');
  // net gemist (de pc sliep): nog tonen binnen een kwartier, daarna niet meer
  assert.equal(planReminders(sync(), Date.parse('2026-11-20T12:40:00Z')).length, 1);
  assert.equal(planReminders(sync(), Date.parse('2026-11-20T12:30:00Z') + LATE_MS + 1).length, 0);
  assert.ok(HORIZON_MS >= 24 * 3600_000);
  assert.equal(snoozeMs(sync()), 30 * 60_000);
  assert.equal(snoozeMs({}), 10 * 60_000, 'standaard 10 minuten');
});

test('vandaag voor het systeemvak en de badge: te laat eerst, dan op tijd en prioriteit, zonder afgevinkte', () => {
  const v = todayItems(sync(), '2026-11-20');
  assert.equal(v.count, 2);
  assert.deepEqual(v.items.map((i) => [i.title, i.overdue]), [['Boodschappen', true], ['Tandarts bellen', false]]);
  assert.equal(todayItems(sync(), '2026-11-20', 1).items.length, 1);
  assert.equal(todayItems({}, '2026-11-20').count, 0);
});

test('het menu in het systeemvak: zoals Todoist, met de taken van vandaag en de vaste overzichten', () => {
  const t = translator('nl');
  const menu = trayMenu(t, { count: 12, items: [{ id: 'taak-0001-aaaa', title: 'Tandarts', priority: 1, overdue: false }] }, { stayInTray: true, quickAddShortcut: 'Control+Space' });
  const labels = menu.filter((x) => x.label).map((x) => x.label);
  assert.deepEqual(labels.slice(0, 4), ['Taak toevoegen', 'Tickory tonen', 'Tandarts', 'Nog 11 voor vandaag…']);
  for (const l of ['Inbox', 'Vandaag', 'Aankomend', 'Voltooid', 'Notities', 'Instellingen', 'In systeemvak blijven draaien', 'Tickory afsluiten']) assert.ok(labels.includes(l), l);
  assert.equal(menu.find((x) => x.id === 'stayInTray').checked, true);
  assert.equal(menu.find((x) => x.id === 'quickAdd').accelerator, 'Control+Space');
  assert.ok(NAV.includes('notes'), 'Notities is onze eigen toevoeging');
  const empty = trayMenu(t, { count: 0, items: [] }, { stayInTray: false, quickAddShortcut: '' });
  assert.ok(empty.some((x) => x.label === 'Niets voor vandaag' && x.enabled === false));
  const main = appMenu(translator('en'), { floatOnTop: true });
  assert.deepEqual(main.map((m) => m.label), ['File', 'Edit', 'View', 'Window', 'Help']);
  assert.equal(main[3].submenu[0].checked, true);
});

test('teksten: Nederlands en Engels hebben dezelfde sleutels, en de taal volgt Windows', () => {
  assert.deepEqual([...KEYS].sort(), [...KEYS_EN].sort());
  assert.equal(langOf(null, 'nl-NL'), 'nl');
  assert.equal(langOf(null, 'de-DE'), 'en');
  assert.equal(langOf('nl', 'en-US'), 'nl');
  assert.equal(translator('nl')('moreToday', { n: 3 }), 'Nog 3 voor vandaag…');
  for (const k of KEYS) assert.notEqual(translator('nl')(k), '', k);
});

test('meldingen van Windows: knoppen via tickory://, en het adres terug alleen met geldige id\'s', () => {
  const t = translator('nl');
  const xml = reminderToastXml({ title: 'Bel <de> "tandarts" & co', time: '13:30', taskId: 'taak-0001-aaaa', reminderId: 'herinnering-01', moment: '2026-11-20T13:30', t });
  assert.match(xml, /Bel &lt;de&gt; &quot;tandarts&quot; &amp; co/);
  assert.match(xml, /content="Voltooien"/);
  assert.match(xml, /content="Uitstellen"/);
  assert.match(xml, /launch="tickory:\/\/open\?task=taak-0001-aaaa/);
  assert.doesNotMatch(reminderToastXml({ title: 'x', time: '', taskId: 'taak-0001-aaaa', t, canComplete: false }), /Voltooien/);
  const url = actionUrl('complete', { taskId: 'taak-0001-aaaa', reminderId: 'herinnering-01', moment: '2026-11-20T13:30' });
  assert.deepEqual(parseActionUrl(url), { action: 'complete', taskId: 'taak-0001-aaaa', reminderId: 'herinnering-01', moment: '2026-11-20T13:30' });
  assert.deepEqual(parseActionUrl('tickory://quick-add'), { action: 'quick-add' });
  for (const bad of ['tickory://delete?task=taak-0001-aaaa', 'tickory://open?task=../../x', 'https://open?task=taak-0001-aaaa', 'tickory://open', 'rommel']) assert.equal(parseActionUrl(bad), null, bad);
});
