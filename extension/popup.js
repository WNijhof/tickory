// Het venster "Opslaan in Tickory": de pagina (of link, of selectie) als taak, met de snelle invoer van Tickory in de titel.
// Het model staat in core/model.js; dit bestand koppelt het aan de pagina en de browser.

import { parseQuickAdd } from './lib/client/core/quickadd.js';
import { createClient } from './core/api.js';
import { errorText, needsReconnect } from './core/errors.js';
import { localize, msgFrom } from './core/i18n.js';
import {
  buildCommands, contextDraft, defaultProject, listsFromSync, newAttempt, nextAttempt, outcomeOf, previewChips, projectOptions, readTitle, usePending,
} from './core/model.js';

const ext = globalThis.browser ?? globalThis.chrome;
const msg = msgFrom((key, subs) => ext.i18n.getMessage(key, subs));
const $ = (id) => document.getElementById(id);
const locale = msg('lang') === 'en' ? 'en-GB' : 'nl-NL';

const els = {
  form: $('save-form'), title: $('title'), chips: $('chips'), description: $('description'), project: $('project'), error: $('error'), save: $('save'),
  done: $('done'), connect: $('connect'), connectText: $('connect-text'), account: $('account'), open: $('open-tickory'),
};

let connection = null;
let lists = null;
let prefilled = '';
let attempt = newAttempt();
let busy = false;

/** Wat de browser over de pagina weet: een keuze uit het contextmenu, of de titel, het adres en de selectie van het tabblad. */
async function pageContext() {
  const tabParam = Number(new URLSearchParams(location.search).get('tab')) || null; // het venster na het contextmenu (zie background.js)
  let tab = null;
  try {
    tab = tabParam ? await ext.tabs.get(tabParam) : (await ext.tabs.query({ active: true, currentWindow: true }))[0] ?? null;
  } catch { /* geen tabblad (bijvoorbeeld een pagina van de browser zelf) */ }
  let pending = null;
  try {
    pending = usePending((await ext.storage.session.get('pending')).pending, { now: Date.now(), tabId: tab?.id ?? null });
    await ext.storage.session.remove('pending');
  } catch { /* geen sessie-opslag */ }
  if (pending) return { ...pending, pageTitle: pending.pageTitle || tab?.title || '' };
  let selectionText = '';
  if (tab?.id !== undefined && /^https?:/.test(tab.url ?? '')) {
    try {
      // alleen met toestemming voor dit tabblad (activeTab: de gebruiker opende de extensie hier zelf); leest alleen de selectie
      const [first] = await ext.scripting.executeScript({ target: { tabId: tab.id }, func: () => String(globalThis.getSelection?.() ?? '').slice(0, 20_000) });
      selectionText = typeof first?.result === 'string' ? first.result : '';
    } catch { /* een pagina waar geen script mag (de webwinkel van de browser, een pdf) */ }
  }
  return { pageUrl: tab?.url ?? '', pageTitle: tab?.title ?? '', selectionText };
}

function showConnect(key) {
  els.form.hidden = true;
  els.done.hidden = true;
  els.connect.hidden = false;
  els.connectText.textContent = msg(key);
  els.account.textContent = '';
  els.open.hidden = true;
}

/** Vult de keuzelijst; de keuze blijft staan als dat project er nog is. */
function fillProjects(keep) {
  const options = lists ? projectOptions(lists) : [];
  if (!options.length && connection.inboxId) options.push({ id: connection.inboxId, name: 'Inbox', depth: 0, disabled: false });
  els.project.replaceChildren(...options.map((o) => {
    const option = document.createElement('option');
    option.value = o.id;
    option.disabled = o.disabled;
    const name = `${'  '.repeat(Math.min(o.depth, 6))}${o.name}`;
    option.textContent = o.disabled ? msg('readOnly', [name]) : name;
    return option;
  }));
  const wanted = options.some((o) => o.id === keep && !o.disabled) ? keep : defaultProject(lists, keep) ?? connection.inboxId;
  if (wanted) els.project.value = wanted;
}

const parsedTitle = () => readTitle(els.title.value, { parse: parseQuickAdd, lists, prefilled, defaultProjectId: els.project.value || connection.inboxId });

function updatePreview() {
  let chips = [];
  try {
    chips = previewChips(parsedTitle(), lists, { defaultProjectId: els.project.value, locale, msg });
  } catch { /* de herkenning faalt nooit hard: dan geen voorbeeld */ }
  els.chips.replaceChildren(...chips.map((c) => {
    const li = document.createElement('li');
    li.className = `chip chip-${c.kind}`;
    li.textContent = c.text;
    li.title = c.text;
    return li;
  }));
}

function showError(err, context) {
  els.error.textContent = typeof err === 'string' ? msg(err) : errorText(err, msg, context);
}

async function refreshLists(client) {
  try {
    const fresh = listsFromSync(await client.lists());
    lists = fresh;
    await ext.storage.local.set({ lists: { ...fresh, origin: connection.origin } });
    fillProjects(els.project.value);
    updatePreview();
  } catch (err) {
    if (needsReconnect(err)) await signedOut();
    // anders: de bewaarde lijst blijft staan (of alleen de Inbox); opslaan kan nog steeds
  }
}

/** De server kent het token niet meer: opnieuw verbinden (het adres en de naam blijven bewaard). */
async function signedOut() {
  await ext.storage.local.set({ connection: { ...connection, token: null } });
  showConnect('reconnect');
}

async function save(event) {
  event.preventDefault();
  if (busy) return;
  els.error.textContent = '';
  const parsed = parsedTitle();
  if (!parsed.content) return showError('errEmptyTitle');
  const commands = buildCommands(parsed, { description: els.description.value, attempt, autoReminder: lists?.autoReminder ?? 30 });
  busy = true;
  els.save.disabled = true;
  els.save.textContent = msg('buttonSaving');
  let response = null;
  let failure = null;
  try {
    response = await createClient({ origin: connection.origin, token: connection.token }).send(commands);
  } catch (err) {
    failure = err;
  }
  const outcome = outcomeOf(commands, response, failure);
  busy = false;
  els.save.disabled = false;
  els.save.textContent = msg('buttonSave');
  if (outcome.ok) {
    await ext.storage.local.set({ lastProject: els.project.value });
    const project = lists?.projects.find((p) => p.id === parsed.project_id)?.name ?? 'Inbox';
    els.form.hidden = true;
    els.done.hidden = false;
    els.done.textContent = msg(outcome.warning ? 'savedPartly' : 'saved', [project]);
    setTimeout(() => window.close(), outcome.warning ? 3500 : 1200);
    return undefined;
  }
  if (failure && needsReconnect(failure)) return signedOut();
  attempt = nextAttempt(attempt, outcome);
  return showError(failure ?? { code: outcome.code });
}

async function main() {
  localize(document, msg);
  document.documentElement.lang = msg('lang');
  $('settings').addEventListener('click', () => { ext.runtime.openOptionsPage(); window.close(); });
  $('connect-button').addEventListener('click', () => { ext.runtime.openOptionsPage(); window.close(); });
  const stored = await ext.storage.local.get(['connection', 'lists', 'lastProject']);
  connection = stored.connection ?? null;
  if (!connection?.token) return showConnect(connection ? 'reconnect' : 'notConnected');
  els.account.textContent = msg('signedInAs', [connection.user.name || connection.user.username, new URL(connection.origin).host]);
  els.open.hidden = false;
  els.open.addEventListener('click', () => { ext.tabs.create({ url: `${connection.origin}/` }); window.close(); });
  if (stored.lists?.origin === connection.origin && stored.lists?.user?.id === connection.user.id) lists = stored.lists;

  const draft = contextDraft(await pageContext(), msg);
  prefilled = draft.title;
  els.title.value = draft.title;
  els.description.value = draft.description;
  fillProjects(stored.lastProject);
  els.form.hidden = false;
  els.title.focus();
  els.title.setSelectionRange(draft.title.length, draft.title.length); // de cursor achteraan: typ er "morgen p1" achter, of begin opnieuw
  updatePreview();

  els.title.addEventListener('input', updatePreview);
  els.project.addEventListener('change', updatePreview);
  // Enter slaat op; een titel is één regel
  els.title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      els.form.requestSubmit();
    }
  });
  els.form.addEventListener('submit', save);
  return refreshLists(createClient({ origin: connection.origin, token: connection.token }));
}

main().catch((err) => showError(err));
