// Startpunt van de web-app: verbindt opslag, synchronisatie en scherm.

import { INBOX_ID } from '../../shared/schema.js';
import { IdbAdapter } from '../core/idb.js';
import { MemoryAdapter, Store } from '../core/store.js';
import { SyncClient, httpTransport } from '../core/syncClient.js';
import { createActions, newId } from '../core/actions.js';
import { listenForChanges } from '../core/events.js';
import { parseQuickAdd } from '../core/quickadd.js';
import { formatDate, formatDue, nowString, todayString } from '../core/format.js';
import { confirmDialog, h, menuDialog, promptDialog, replace, toast } from './dom.js';
import { mainView, sidebar } from './render.js';
import { openTaskDialog } from './taskDialog.js';

const TOKEN_KEY = 'eigen-tool.token';
const ROUTE_KEY = 'eigen-tool.route';

const $ = (id) => document.getElementById(id);
const getToken = () => localStorage.getItem(TOKEN_KEY);

function loadRoute() {
  try {
    const r = JSON.parse(localStorage.getItem(ROUTE_KEY) ?? 'null');
    if (r && ['today', 'upcoming', 'project'].includes(r.type)) return r;
  } catch { /* ongeldige waarde: begin bij Vandaag */ }
  return { type: 'today' };
}

const ui = { route: loadRoute(), showCompleted: new Set(), syncState: 'idle', askingToken: false, scheduled: false };
let adapter;
let store;
let sync;
let actions;
let events;

// ---------- tekenen ----------

function invalidate() {
  if (ui.scheduled) return;
  ui.scheduled = true;
  requestAnimationFrame(() => {
    ui.scheduled = false;
    render();
  });
}

function render() {
  const today = todayString();
  if (ui.route.type === 'project' && store.ready && store.view.projects.size > 0 && !store.view.projects.has(ui.route.id)) {
    ui.route = { type: 'today' }; // het project is verwijderd (bijvoorbeeld op een ander apparaat)
  }
  replace($('sidebar'), sidebar({ view: store.view, today, route: ui.route, handlers }));
  const main = mainView({
    view: store.view, route: ui.route, today, now: nowString(),
    showCompleted: ui.route.type === 'project' && ui.showCompleted.has(ui.route.id), handlers,
  });
  $('view-title').textContent = main.title;
  document.title = `${main.title} · Taken`;
  replace($('content'), main.nodes);
  renderStatus();
  renderPreview();
}

function renderStatus() {
  const n = store.queueLength;
  const waiting = n > 0 ? `${n} wachtend` : '';
  const text = {
    idle: waiting || 'Bijgewerkt',
    syncing: 'Bezig…',
    offline: ['Offline', waiting].filter(Boolean).join(' · '),
    unauthorized: 'Token nodig',
    error: 'Bijwerken mislukt',
  }[ui.syncState];
  const el = $('sync-status');
  el.textContent = text;
  el.dataset.state = ui.syncState === 'idle' && n > 0 ? 'pending' : ui.syncState;
}

// ---------- snel toevoegen ----------

function quickContext() {
  if (ui.route.type === 'project' && store.view.projects.has(ui.route.id)) return { defaultProjectId: ui.route.id };
  if (ui.route.type === 'today') return { defaultProjectId: INBOX_ID, defaultDue: { date: todayString(), string: 'vandaag', lang: 'nl' } };
  return { defaultProjectId: INBOX_ID };
}

function renderPreview() {
  const text = $('quick-input').value;
  const host = $('quick-preview');
  if (!text.trim()) return replace(host);
  const ctx = quickContext();
  const p = parseQuickAdd(text, { view: store.view, now: new Date(), ...ctx });
  const today = todayString();
  const chip = (kind, label) => h('span', { class: `chip chip-${kind}` }, label);
  const view = store.view;
  return replace(host,
    chip('title', p.content || '(nog geen naam)'),
    p.due && p.due !== ctx.defaultDue && chip('due', formatDue(p.due, today)),
    p.deadline && chip('deadline', `deadline ${formatDate(p.deadline, today)}`),
    p.project_id !== ctx.defaultProjectId && chip('project', `#${view.projects.get(p.project_id)?.name ?? ''}`),
    p.section_id && chip('project', `/${view.sections.get(p.section_id)?.name ?? ''}`),
    p.labels.map((id) => chip('label', `@${view.labels.get(id)?.name ?? ''}`)),
    p.newLabels.map((name) => chip('label', `@${name} (nieuw)`)),
    p.priority < 4 && chip(`prio prio-${p.priority}`, `P${p.priority}`),
  );
}

async function submitQuickAdd(e) {
  e.preventDefault();
  const input = $('quick-input');
  const p = parseQuickAdd(input.value, { view: store.view, now: new Date(), ...quickContext() });
  if (!p.content) {
    toast('Geef de taak een naam.');
    return;
  }
  input.value = '';
  renderPreview();
  await actions.addTask(p);
}

// ---------- handelingen ----------

function navigate(route) {
  ui.route = route;
  localStorage.setItem(ROUTE_KEY, JSON.stringify(route));
  document.body.classList.remove('nav-open');
  render();
}

const handlers = {
  navigate,

  async toggle(task) {
    if (task.checked) return actions.uncompleteTask(task.id);
    await actions.completeTask(task.id);
    if (task.due?.recurrence) {
      const next = store.view.tasks.get(task.id);
      return toast(next?.due ? `Volgende keer: ${formatDue({ date: next.due.date }, todayString())}` : 'Taak voltooid');
    }
    return toast('Taak voltooid', { action: { label: 'Ongedaan maken', run: () => actions.uncompleteTask(task.id) } });
  },

  open(task) {
    return openTaskDialog({ task, store, actions, today: todayString });
  },

  async addProject() {
    const name = await promptDialog({ title: 'Nieuw project', label: 'Naam' });
    if (!name) return;
    const id = await actions.addProject({ name });
    navigate({ type: 'project', id });
  },

  async addSection(project) {
    const name = await promptDialog({ title: `Nieuwe sectie in ${project.name}`, label: 'Naam' });
    if (name) await actions.addSection(project.id, name);
  },

  async projectMenu(project) {
    const choice = await menuDialog({
      title: project.name,
      items: [{ value: 'rename', label: 'Naam wijzigen' }, { value: 'delete', label: 'Project verwijderen', danger: true }],
    });
    if (choice === 'rename') {
      const name = await promptDialog({ title: 'Naam wijzigen', label: 'Naam', value: project.name });
      if (name && name !== project.name) await actions.updateProject(project.id, { name });
    } else if (choice === 'delete') {
      const ok = await confirmDialog({ title: 'Project verwijderen?', text: `"${project.name}" wordt verwijderd, met alle secties, taken en subprojecten erin.` });
      if (ok) {
        await actions.deleteProject(project.id);
        navigate({ type: 'project', id: INBOX_ID });
      }
    }
  },

  async sectionMenu(section) {
    const choice = await menuDialog({
      title: section.name,
      items: [{ value: 'rename', label: 'Naam wijzigen' }, { value: 'delete', label: 'Sectie verwijderen', danger: true }],
    });
    if (choice === 'rename') {
      const name = await promptDialog({ title: 'Naam wijzigen', label: 'Naam', value: section.name });
      if (name && name !== section.name) await actions.updateSection(section.id, { name });
    } else if (choice === 'delete') {
      const ok = await confirmDialog({ title: 'Sectie verwijderen?', text: `"${section.name}" wordt verwijderd, met alle taken erin.` });
      if (ok) await actions.deleteSection(section.id);
    }
  },

  toggleCompleted(projectId) {
    if (!ui.showCompleted.delete(projectId)) ui.showCompleted.add(projectId);
    render();
  },

  async settings() {
    const choice = await menuDialog({
      title: 'Instellingen',
      items: [
        { value: 'sync', label: 'Nu bijwerken' },
        { value: 'token', label: 'Token wijzigen' },
        { value: 'logout', label: 'Afmelden en lokale gegevens wissen', danger: true },
      ],
    });
    if (choice === 'sync') sync.requestSync(0);
    else if (choice === 'token') askToken();
    else if (choice === 'logout') logout();
  },
};

async function askToken() {
  if (ui.askingToken) return;
  ui.askingToken = true;
  try {
    const token = await promptDialog({
      title: 'Verbinden met je server', label: 'Token', type: 'password', okText: 'Verbinden',
      hint: 'Het geheime token waarmee de server is gestart (TODO_TOKEN). Het wordt alleen op dit apparaat bewaard.',
    });
    if (!token) return;
    localStorage.setItem(TOKEN_KEY, token);
    events.restart();
    sync.requestSync(0);
  } finally {
    ui.askingToken = false;
  }
}

async function logout() {
  const waiting = store.queueLength;
  const ok = await confirmDialog({
    title: 'Afmelden?',
    text: waiting > 0
      ? `Er ${waiting === 1 ? 'staat nog 1 wijziging' : `staan nog ${waiting} wijzigingen`} te wachten die niet naar de server zijn gestuurd. Die gaan verloren.`
      : 'Het token en de lokale kopie van je taken worden van dit apparaat gewist. Op de server blijft alles staan.',
    okText: 'Afmelden',
  });
  if (!ok) return;
  events.stop();
  sync.stop();
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ROUTE_KEY);
  if (adapter.clear) await adapter.clear();
  location.reload();
}

// ---------- opstarten ----------

async function boot() {
  try {
    adapter = new IdbAdapter();
    await adapter.open();
  } catch {
    adapter = new MemoryAdapter();
    toast('Lokale opslag is niet beschikbaar. De app werkt, maar bewaart niets als je dit venster sluit.', { kind: 'error', timeout: 0 });
  }
  store = new Store(adapter);
  await store.init();

  const clientId = newId();
  sync = new SyncClient({
    store,
    transport: httpTransport({ getToken, clientId }),
    onState: (s) => {
      ui.syncState = s;
      renderStatus();
      if (s === 'unauthorized') askToken();
    },
    onCommandErrors: (errors) => {
      for (const e of errors) toast(`Een wijziging is niet doorgevoerd: ${e.error}`, { kind: 'error', timeout: 10_000 });
    },
  });

  // andere tabbladen op dit apparaat laten weten dat er lokaal iets is veranderd (ook zonder verbinding)
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('eigen-tool') : null;
  channel?.addEventListener('message', () => store.init());
  actions = createActions(store, {
    requestSync: () => {
      channel?.postMessage('changed');
      sync.requestSync();
    },
  });

  events = listenForChanges({ getToken, clientId, onSyncNeeded: () => sync.requestSync(0), onConnected: () => sync.requestSync(0) });
  store.subscribe(invalidate);
  window.addEventListener('online', () => {
    events.restart();
    sync.requestSync(0);
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) sync.requestSync(0);
  });
  setInterval(invalidate, 60_000); // "te laat" en de datum van vandaag schuiven mee met de klok

  $('quick-add').addEventListener('submit', submitQuickAdd);
  $('quick-input').addEventListener('input', renderPreview);
  $('menu-button').addEventListener('click', () => document.body.classList.toggle('nav-open'));
  $('scrim').addEventListener('click', () => document.body.classList.remove('nav-open'));
  $('sync-status').addEventListener('click', () => (ui.syncState === 'unauthorized' ? askToken() : sync.requestSync(0)));

  render();
  document.body.classList.add('ready');
  if (getToken()) sync.requestSync(0);
  else askToken();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* zonder service worker werkt de app alleen online */ });
    // Even na het starten laten controleren of de offline-kopie compleet is. Een netwerkfilter (AdGuard) kan die
    // kort na het aanleggen wissen; het filter is dan klaar en de kopie wordt opnieuw gevuld.
    setTimeout(() => {
      navigator.serviceWorker.ready.then((registration) => registration.active?.postMessage('ensure-shell')).catch(() => {});
    }, 8000);
  }
}

boot().catch((err) => {
  console.error(err);
  document.body.append(h('p', { class: 'fatal' }, 'De app kon niet starten. Herlaad de pagina; blijft dit zo, kijk dan in de console van de browser.'));
});
