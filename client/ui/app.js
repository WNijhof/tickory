// Startpunt van de web-app: verbindt opslag, synchronisatie en scherm.

import { IdbAdapter } from '../core/idb.js';
import { MemoryAdapter, Store } from '../core/store.js';
import { SyncClient } from '../core/syncClient.js';
import { createActions, newId } from '../core/actions.js';
import { androidBridge, taskIdFromHash, watchReminders } from '../core/android.js';
import { deviceName } from '../core/auth.js';
import { createBackend } from '../core/backend.js';
import { createPushClient } from '../core/push.js';
import { isArchivedProject, roleIn } from '../core/selectors.js';
import { parseQuickAdd } from '../core/quickadd.js';
import { describeCommandError } from '../core/messages.js';
import { formatDue, nowString, todayString } from '../core/format.js';
import { reschedule } from '../core/quickDates.js';
import { createShortcuts } from '../core/shortcuts.js';
import { LANGUAGES, getLanguage, setLanguage, t } from '../core/i18n.js';
import { confirmDialog, h, menuDialog, promptDialog, replace, toast } from './dom.js';
import { bindList, mainView, sidebar, sidebarHooks } from './render.js';
import { createDragDrop } from './dragdrop.js';
import { openTaskDialog } from './taskDialog.js';
import { openProjectDialog } from './projectDialog.js';
import { openQuickAddDialog, previewChips } from './quickAdd.js';
import { archiveDialog, pickDay, projectCommentsDialog, shortcutsDialog } from './miscDialogs.js';
import { accountDialog, adminDialog, loginDialog } from './accountDialogs.js';
import { openShareDialog } from './shareDialog.js';
import { notificationsDialog } from './reminderUi.js';
import { installFind, isFindRoute } from './find.js';

const ROUTE_KEY = 'tickory.route';

const $ = (id) => document.getElementById(id);
const clientId = newId();
/** Alle communicatie met de server (zie core/backend.js). */
const backend = createBackend({ clientId });
const getToken = () => backend.getToken();

function loadRoute() {
  try {
    const r = JSON.parse(localStorage.getItem(ROUTE_KEY) ?? 'null');
    if (r && (['today', 'upcoming', 'project'].includes(r.type) || isFindRoute(r))) return r;
  } catch { /* ongeldige waarde: begin bij Vandaag */ }
  return { type: 'today' };
}

const ui = { route: loadRoute(), showCompleted: new Set(), syncState: 'idle', askingLogin: false, scheduled: false };
const api = backend.api;
/** De Inbox van de ingelogde gebruiker; null zolang de server nog niet heeft gezegd wie je bent. */
const inboxId = () => store?.me?.inbox_project_id ?? null;
/** De brug naar de Android-app; buiten die app doet hij niets (zie core/android.js). Niet in de demo. */
const bridge = androidBridge(backend.demo ? undefined : window.TickoryAndroid);
/** Meldingen in de browser (Web Push). In de Android-app niet nodig: die plant zijn meldingen zelf in. */
const pushClient = createPushClient({ getToken, lang: getLanguage });
const usesPush = () => !backend.demo && !bridge.available;
const deviceZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
let adapter;
let store;
let sync;
let actions;
let events;

// ---------- taal ----------

/**
 * Zet de taal op het vaste deel van de pagina (index.html). Daar staat de Nederlandse tekst als terugval voor het
 * geval dit script niet draait; de rest van het scherm krijgt zijn tekst bij het tekenen.
 */
function applyLanguage() {
  document.documentElement.lang = getLanguage();
  $('sidebar').setAttribute('aria-label', t('shell.navigation'));
  $('menu-button').setAttribute('aria-label', t('shell.menu'));
  $('sync-status').title = t('shell.syncTitle');
  $('quick-input').placeholder = t('quick.placeholder');
  $('quick-input').setAttribute('aria-label', t('quick.label'));
  $('quick-add').querySelector('button[type="submit"]').textContent = t('common.add');
}
applyLanguage(); // meteen bij het laden, zodat de Nederlandse terugval in een andere taal niet lang in beeld staat

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
  // Het scherm wordt helemaal opnieuw opgebouwd; waar de toetsenbordfocus stond, zetten we hem daarna terug (via data-fk).
  const focused = document.activeElement?.dataset?.fk ?? null;
  replace($('sidebar'), sidebar({ view: store.view, today, route: ui.route, handlers, me: store.me }));
  for (const hook of sidebarHooks) hook({ search: $('sidebar-search'), extra: $('sidebar-extra') });
  const main = mainView({
    view: store.view, route: ui.route, today, now: nowString(),
    showCompleted: ui.route.type === 'project' && ui.showCompleted.has(ui.route.id), handlers,
    me: store.me, userName: (id) => store.userName(id),
  });
  $('view-title').textContent = main.title;
  $('view-count').textContent = main.count === null ? '' : t('view.count', { count: main.count });
  replace($('view-lead'), main.lead);
  replace($('view-actions'), main.actions);
  document.title = `${main.title} · Tickory`;
  replace($('content'), main.nodes);
  if (focused && document.activeElement === document.body) document.querySelector(`[data-fk="${CSS.escape(focused)}"]`)?.focus();
  renderStatus();
  renderPreview();
}

function renderStatus() {
  const n = store.queueLength;
  const waiting = n > 0 ? t('sync.waiting', { count: n }) : '';
  // Zonder aanmelding is er niets bijgewerkt, ook al is er (nog) geen sync mislukt.
  const state = getToken() ? ui.syncState : 'unauthorized';
  const text = {
    idle: waiting || t('sync.upToDate'),
    syncing: t('sync.syncing'),
    offline: [t('sync.offline'), waiting].filter(Boolean).join(' · '),
    unauthorized: t('sync.signInNeeded'),
    error: t('sync.failed'),
  }[state];
  const el = $('sync-status');
  el.textContent = text;
  el.dataset.state = state === 'idle' && n > 0 ? 'pending' : state;
}

// ---------- snel toevoegen ----------

function quickContext() {
  if (ui.route.type === 'project' && store.view.projects.has(ui.route.id)) return { defaultProjectId: ui.route.id };
  // `string` en `lang` horen bij de datumtaal (wat de herkenner leest), niet bij de taal van de interface: die blijven Nederlands.
  if (ui.route.type === 'today') return { defaultProjectId: inboxId(), defaultDue: { date: todayString(), string: 'vandaag', lang: 'nl' } };
  return { defaultProjectId: inboxId() };
}

function renderPreview() {
  const host = $('quick-preview');
  const context = quickContext();
  return replace(host, context.defaultProjectId ? previewChips($('quick-input').value, { view: store.view, context }) : []);
}

async function submitQuickAdd(e) {
  e.preventDefault();
  const input = $('quick-input');
  if (!quickContext().defaultProjectId) {
    toast(t('quick.signInFirst'));
    return;
  }
  const p = parseQuickAdd(input.value, { view: store.view, now: new Date(), ...quickContext() });
  if (!p.content) {
    toast(t('task.nameRequired'));
    return;
  }
  input.value = '';
  renderPreview();
  await actions.addTask(p);
}

// ---------- handelingen ----------

function navigate(route) {
  ui.route = route;
  if (!backend.demo) localStorage.setItem(ROUTE_KEY, JSON.stringify(route));
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
      return toast(next?.due ? t('task.nextTime', { date: formatDue({ date: next.due.date }, todayString()) }) : t('task.completed'));
    }
    return toast(t('task.completed'), { action: { label: t('task.undo'), run: () => actions.uncompleteTask(task.id) } });
  },

  open(task) {
    return openTaskDialog({ task, store, actions, today: todayString, toggle: handlers.toggle });
  },

  /** Het venster "Taak toevoegen"; `target` zegt waar de taak standaard komt (project, sectie, of vandaag), anders het huidige scherm. */
  quickAdd(target = null) {
    const context = target ?? (ui.route.type === 'project' ? { projectId: ui.route.id } : ui.route.type === 'today' ? { due: 'today' } : {});
    return openQuickAddDialog({ store, actions, context });
  },

  async removeTask(task) {
    const ok = await confirmDialog({ title: t('task.deleteTitle'), text: t('task.deleteText', { name: task.content }) });
    if (ok) await actions.deleteTask(task.id);
  },

  /** Een andere dag kiezen voor een taak, zonder het taakvenster. */
  async reschedule(task) {
    const picked = await pickDay({ today: todayString(), hasDue: Boolean(task.due) });
    if (picked) await actions.updateTask(task.id, { due: reschedule(task.due, picked.date) });
  },

  toggleProject: (project) => actions.updateProject(project.id, { is_collapsed: !project.is_collapsed }),
  toggleSection: (section) => actions.updateSection(section.id, { is_collapsed: !section.is_collapsed }),
  toggleTask: (task) => actions.updateTask(task.id, { is_collapsed: !task.is_collapsed }),

  async addProject(parentId = null) {
    const made = await openProjectDialog({ view: store.view, parentId });
    if (!made) return;
    const id = await actions.addProject(made);
    navigate({ type: 'project', id });
  },

  async editProject(project) {
    const edited = await openProjectDialog({ view: store.view, project });
    if (!edited) return;
    const changes = {};
    if (edited.name !== project.name) changes.name = edited.name;
    if (edited.color !== project.color) changes.color = edited.color;
    if (edited.is_favorite !== Boolean(project.is_favorite)) changes.is_favorite = edited.is_favorite;
    if (Object.keys(changes).length > 0) await actions.updateProject(project.id, changes);
  },

  projectComments: (project) => projectCommentsDialog({ store, actions, project }),

  showArchive: () => archiveDialog({
    store,
    onOpen: (project) => navigate({ type: 'project', id: project.id }),
    onRestore: (project) => handlers.restoreProject(project),
  }),

  async restoreProject(project) {
    await actions.unarchiveProject(project.id);
    toast(t('project.restored', { name: project.name }));
  },

  shortcuts: () => shortcutsDialog(),

  async addSection(project) {
    const name = await promptDialog({ title: t('section.newIn', { name: project.name }), label: t('common.name') });
    if (name) await actions.addSection(project.id, name);
  },

  async projectMenu(project) {
    const mine = roleIn(store.view, project.id, store.userId);
    const choice = await menuDialog({
      title: project.name,
      items: [
        { value: 'edit', label: t('project.editMenu') },
        { value: 'sub', label: t('project.addSub') },
        { value: 'favorite', label: project.is_favorite ? t('project.unfavorite') : t('project.favoriteAdd') },
        { value: 'share', label: mine === 'member' ? t('project.members') : t('project.shareMenu') },
        mine === 'owner' && !isArchivedProject(store.view, project.id) && { value: 'archive', label: t('project.archive') }, // een gearchiveerd project zet je terug (de balk bovenaan)
        mine === 'member'
          ? { value: 'leave', label: t('project.leave'), danger: true }
          : { value: 'delete', label: t('project.delete'), danger: true },
      ].filter(Boolean),
    });
    if (choice === 'edit') {
      await handlers.editProject(project);
    } else if (choice === 'sub') {
      await handlers.addProject(project.id);
    } else if (choice === 'favorite') {
      await actions.updateProject(project.id, { is_favorite: !project.is_favorite });
    } else if (choice === 'archive') {
      await actions.archiveProject(project.id);
      navigate({ type: 'project', id: inboxId() });
      toast(t('project.archived', { name: project.name }), { action: { label: t('task.undo'), run: () => actions.unarchiveProject(project.id) } });
    } else if (choice === 'share') {
      await handlers.shareProject(project);
    } else if (choice === 'leave') {
      const ok = await confirmDialog({ title: t('project.leaveTitle'), text: t('project.leaveText', { name: project.name }), okText: t('project.leaveOk') });
      if (ok) {
        await actions.leaveProject(project.id);
        navigate({ type: 'project', id: inboxId() });
      }
    } else if (choice === 'delete') {
      const shared = [...store.view.members.values()].filter((m) => m.project_id === project.id).length > 1;
      const ok = await confirmDialog({
        title: t('project.deleteTitle'),
        text: shared ? t('project.deleteTextShared', { name: project.name }) : t('project.deleteText', { name: project.name }),
      });
      if (ok) {
        await actions.deleteProject(project.id);
        navigate({ type: 'project', id: inboxId() });
      }
    }
  },

  async shareProject(project) {
    const outcome = await openShareDialog({ store, actions, project });
    if (outcome === 'left') navigate({ type: 'project', id: inboxId() });
  },

  async sectionMenu(section) {
    const choice = await menuDialog({
      title: section.name,
      items: [{ value: 'rename', label: t('common.rename') }, { value: 'delete', label: t('section.delete'), danger: true }],
    });
    if (choice === 'rename') {
      const name = await promptDialog({ title: t('common.rename'), label: t('common.name'), value: section.name });
      if (name && name !== section.name) await actions.updateSection(section.id, { name });
    } else if (choice === 'delete') {
      const ok = await confirmDialog({ title: t('section.deleteTitle'), text: t('section.deleteText', { name: section.name }) });
      if (ok) await actions.deleteSection(section.id);
    }
  },

  toggleCompleted(projectId) {
    if (!ui.showCompleted.delete(projectId)) ui.showCompleted.add(projectId);
    render();
  },

  async settings() {
    if (!store.me) return askLogin();
    const choice = await menuDialog({
      title: t('settings.title'),
      items: [
        { value: 'account', label: t('settings.account') },
        { value: 'notifications', label: t('settings.notifications') },
        { value: 'sync', label: t('settings.syncNow') },
        { value: 'language', label: t('settings.language') },
        { value: 'logout', label: t('settings.signOut'), danger: true },
      ],
    });
    if (choice === 'sync') sync.requestSync(0);
    else if (choice === 'account') await accountFlow();
    else if (choice === 'notifications') await notificationsDialog({ store, actions, bridge, pushClient });
    else if (choice === 'language') await chooseLanguage();
    else if (choice === 'logout') logout();
    return undefined;
  },
};

/**
 * De taalkeuze. Wisselen werkt direct: het vaste deel van de pagina en het scherm worden opnieuw getekend, zonder de pagina
 * te herladen (dat kan zonder verbinding niet altijd). De keuze blijft op dit apparaat bewaard, ook na afmelden.
 */
async function chooseLanguage() {
  const choice = await menuDialog({
    title: t('settings.language'),
    items: LANGUAGES.map((l) => ({ value: l.code, label: l.code === getLanguage() ? `${l.name} ✓` : l.name })),
  });
  if (!choice || choice === getLanguage()) return;
  setLanguage(choice);
  applyLanguage();
  render();
  if (usesPush()) pushClient.refresh().catch(() => {}); // de melding komt in de nieuwe taal
}

/** Het accountscherm, met doorverwijzing naar gebruikersbeheer of afmelden. */
async function accountFlow() {
  const next = await accountDialog({ me: store.me, api });
  if (next === 'admin') {
    await adminDialog({ me: store.me, api });
    return accountFlow();
  }
  if (next === 'logout') return logout();
  if (next === 'relogin') return askLogin();
  return undefined;
}

/**
 * Het inlogscherm. Lukt het, dan bewaren we het token. Logt er iemand anders in dan wiens gegevens op dit apparaat staan,
 * dan wissen we die eerst (na bevestiging als er nog wijzigingen wachten): gegevens van de één horen nooit bij de ander terecht te komen.
 */
async function askLogin(note = '') {
  if (ui.askingLogin) return;
  ui.askingLogin = true;
  try {
    await loginDialog({
      username: store.me?.username ?? '',
      note: note || (store.me ? t('login.sessionEnded') : ''),
      attempt: async (username, password) => {
        const res = await api.login(username, password, deviceName(navigator.userAgent, { app: Boolean(window.TickoryAndroid) }));
        const other = store.me && store.me.id !== res.me.id;
        if (other) {
          const waiting = store.queueLength;
          const ok = await confirmDialog({
            title: t('login.switchTitle', { name: res.me.name }),
            text: waiting > 0 ? t('login.switchTextWaiting', { name: store.me.name, count: waiting }) : t('login.switchText', { name: store.me.name }),
            okText: t('login.switchOk'),
          });
          if (!ok) {
            api.logout(res.token).catch(() => {});
            throw new Error('geannuleerd');
          }
          events.stop();
          sync.stop();
          localStorage.removeItem(ROUTE_KEY);
          if (adapter.clear) await adapter.clear();
        }
        backend.setToken(res.token);
        bridge.setSession(res.token);
        if (other) {
          location.reload();
          return res;
        }
        events.restart();
        sync.requestSync(0);
        return res;
      },
    });
  } finally {
    ui.askingLogin = false;
  }
}

async function logout() {
  const waiting = store.queueLength;
  const ok = await confirmDialog({
    title: t('logout.title'),
    text: waiting > 0 ? t('logout.textWaiting', { count: waiting }) : t('logout.text'),
    okText: t('account.signOut'),
  });
  if (!ok) return;
  events.stop();
  sync.stop();
  if (usesPush()) await pushClient.disable().catch(() => { /* de server ruimt een aanmelding zonder sessie ook zelf op */ });
  await api.logout().catch(() => { /* zonder verbinding: het token wordt hier toch gewist; intrekken kan later via Account */ });
  bridge.setSession(''); // de Android-app wist dan zijn token en alle geplande herinneringen
  backend.clearToken();
  localStorage.removeItem(ROUTE_KEY);
  if (adapter.clear) await adapter.clear();
  location.reload();
}

// ---------- een taak openen vanuit een melding ----------

let pendingTaskId = null;
let pendingSince = 0;

/** Opent het taakvenster; kent de app de taak nog niet (de eerste sync loopt nog), dan zodra hij binnenkomt. */
function openTaskById(id) {
  const task = store.view.tasks.get(id);
  if (!task) {
    pendingTaskId = id;
    pendingSince = Date.now();
    return;
  }
  pendingTaskId = null;
  if (document.querySelector('#task-dialog')) return; // er is al een taak open
  openTaskDialog({ task, store, actions, today: todayString });
}

function openPendingTask() {
  if (pendingTaskId && Date.now() - pendingSince > 30_000) pendingTaskId = null; // een taak die niet komt: opgeven
  if (pendingTaskId && store.view.tasks.has(pendingTaskId)) openTaskById(pendingTaskId);
}

function openTaskFromHash() {
  const id = taskIdFromHash(location.hash);
  if (!id) return;
  history.replaceState(null, '', `${location.pathname}${location.search}`); // het adres weer schoon
  openTaskById(id);
}

// ---------- tijdzone ----------

let zoneChecked = false;

/** Eenmalig, zodra de instellingen binnen zijn: de tijdzone van dit apparaat vastleggen, zodat de server meldingen op de goede tijd stuurt. */
function maybeSetTimezone() {
  if (zoneChecked || !store?.userId || backend.demo) return;
  const settings = store.view.settings.get(`settings-${store.userId}`);
  if (!settings) return;
  zoneChecked = true;
  if (!settings.timezone) actions.updateSettings({ timezone: deviceZone() });
}

// ---------- opstarten ----------

async function boot() {
  try {
    // In de demo bewaren we niets: elke keer openen begint opnieuw met de voorbeeldgegevens.
    adapter = backend.demo ? new MemoryAdapter() : new IdbAdapter();
    if (adapter.open) await adapter.open();
  } catch {
    adapter = new MemoryAdapter();
    toast(t('boot.noStorage'), { kind: 'error', timeout: 0 });
  }
  store = new Store(adapter);
  await store.init();

  sync = new SyncClient({
    store,
    transport: backend.transport,
    onState: (s) => {
      ui.syncState = s;
      renderStatus();
      if (s === 'unauthorized') askLogin();
    },
    onCommandErrors: (errors) => {
      for (const e of errors) toast(describeCommandError(e), { kind: 'error', timeout: 10_000 });
    },
  });

  // andere tabbladen op dit apparaat laten weten dat er lokaal iets is veranderd (ook zonder verbinding)
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('tickory') : null;
  channel?.addEventListener('message', () => store.init());
  actions = createActions(store, {
    requestSync: () => {
      channel?.postMessage('changed');
      sync.requestSync();
    },
  });

  events = backend.listen({ onSyncNeeded: () => sync.requestSync(0), onConnected: () => sync.requestSync(0) });
  store.subscribe(invalidate);
  store.subscribe(maybeSetTimezone);
  store.subscribe(openPendingTask);
  watchReminders({ store, bridge }); // Android hoort het zodra er iets aan de meldingen verandert
  window.addEventListener('online', () => {
    events.restart();
    sync.requestSync(0);
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) sync.requestSync(0);
  });
  setInterval(invalidate, 60_000); // "te laat" en de datum van vandaag schuiven mee met de klok

  bindList($('content'), handlers); // het gedrag van alle regels in de takenlijst, met één luisteraar
  installFind({ store, actions, handlers, navigate, getRoute: () => ui.route, persist: !backend.demo }); // zoeken, filters en labels (ui/find.js)
  // slepen en verplaatsen van taken en projecten, ook met het toetsenbord (ui/dragdrop.js)
  createDragDrop({
    content: $('content'), sidebar: $('sidebar'), actions,
    getContext: () => ({ view: store.view, userId: store.userId, showCompleted: (projectId) => ui.showCompleted.has(projectId) }),
  });
  $('quick-add').addEventListener('submit', submitQuickAdd);
  $('quick-input').addEventListener('input', renderPreview);
  $('menu-button').addEventListener('click', () => document.body.classList.toggle('nav-open'));
  $('scrim').addEventListener('click', () => document.body.classList.remove('nav-open'));
  $('sync-status').addEventListener('click', () => (ui.syncState === 'unauthorized' || !getToken() ? askLogin() : sync.requestSync(0)));

  // Sneltoetsen (zie core/shortcuts.js): alleen buiten invoervelden en zonder open venster. `/` en Ctrl+K zijn voor zoeken (ui/find.js).
  const shortcuts = createShortcuts({
    addTask: () => handlers.quickAdd(),
    goToday: () => navigate({ type: 'today' }),
    goUpcoming: () => navigate({ type: 'upcoming' }),
    goInbox: () => inboxId() && navigate({ type: 'project', id: inboxId() }),
    showHelp: () => handlers.shortcuts(),
    blocked: () => Boolean(document.querySelector('dialog[open]')) || !store.ready,
  });
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    if (e.key === 'Escape' && document.body.classList.contains('nav-open')) document.body.classList.remove('nav-open');
    else if (shortcuts.handle(e)) e.preventDefault();
  });

  render();
  document.body.classList.add('ready');
  if (getToken()) {
    bridge.setSession(getToken()); // bij elke start, ook als de app al was ingelogd
    if (usesPush()) pushClient.refresh().catch(() => {});
    sync.requestSync(0);
  } else {
    askLogin();
  }

  // Een melding aangetikt: de taak openen, via de adresbalk (#task=…, Android en nieuwe vensters) of via de service worker.
  openTaskFromHash();
  window.addEventListener('hashchange', openTaskFromHash);
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.type === 'open-task' && typeof e.data.id === 'string') openTaskById(e.data.id);
  });

  if ('serviceWorker' in navigator && !backend.demo) {
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
  document.body.append(h('p', { class: 'fatal' }, t('boot.failed')));
});
