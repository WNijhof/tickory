// Startpunt van de web-app: verbindt opslag, synchronisatie en scherm.

import { IdbAdapter } from '../core/idb.js';
import { MemoryAdapter, Store } from '../core/store.js';
import { SyncClient } from '../core/syncClient.js';
import { createActions, newId } from '../core/actions.js';
import { addContextFromHash, androidBridge, taskIdFromHash, watchReminders, watchWidgets } from '../core/android.js';
import { fetchSharedFiles, shareFromHash } from '../core/share.js';
import { deviceName } from '../core/auth.js';
import { createBackend } from '../core/backend.js';
import { createPushClient } from '../core/push.js';
import { isArchivedProject, roleIn } from '../core/selectors.js';
import { moveTargets } from '../core/projectViews.js';
import { parseQuickAdd } from '../core/quickadd.js';
import { describeCommandError, quietCommandError } from '../core/messages.js';
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
import { createAttachmentManager, IdbFiles, MemoryFiles } from '../core/attachments.js';
import { configureAttachments, rejectionText } from './attachments.js';
import { exportDialog } from './exportDialog.js';
import { placesDialog } from './placesUi.js';
import { createTemplatesUi } from './templateUi.js';
import { setUpcomingStyle } from './viewSwitch.js';
import { viewPrefs } from './viewPrefs.js';
import { installFind, isFindRoute } from './find.js';
import { installInbox } from './inbox.js';
import { installActivity } from './activity.js';
import { canEditProject } from '../core/access.js';

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
let attachments;
/** Het scherm Activiteit (ui/activity.js). */
let activityUi = null;
/** Sjablonen (ui/templateUi.js); pas aangemaakt zodra opslag en handelingen er zijn. */
let templatesUiInstance = null;
const templatesUi = () => (templatesUiInstance ??= createTemplatesUi({ store, actions, navigate }));

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
  // in een project dat je alleen leest (core/access.js) kan geen taak: dan gaat ze naar de Inbox, en #project noemt alleen projecten waar het wel kan
  const canAddTo = (id) => canEditProject(store.view, id, store.userId);
  if (ui.route.type === 'project' && store.view.projects.has(ui.route.id) && canAddTo(ui.route.id)) return { defaultProjectId: ui.route.id, canAddTo };
  // `string` en `lang` horen bij de datumtaal (wat de herkenner leest), niet bij de taal van de interface: die blijven Nederlands.
  if (ui.route.type === 'today') return { defaultProjectId: inboxId(), defaultDue: { date: todayString(), string: 'vandaag', lang: 'nl' }, canAddTo };
  return { defaultProjectId: inboxId(), canAddTo };
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

  /** Tekent het scherm opnieuw (voor onderdelen met eigen schermtoestand, zoals de gekozen maand van de kalender). */
  refresh: () => render(),

  async toggle(task) {
    if (!canEditProject(store.view, task.project_id, store.userId)) return handlers.readOnlyNotice(task);
    if (task.checked) return actions.uncompleteTask(task.id);
    await actions.completeTask(task.id);
    if (task.due?.recurrence) {
      const next = store.view.tasks.get(task.id);
      return toast(next?.due ? t('task.nextTime', { date: formatDue({ date: next.due.date }, todayString()) }) : t('task.completed'));
    }
    return toast(t('task.completed'), { action: { label: t('task.undo'), run: () => actions.uncompleteTask(task.id) } });
  },

  /** Een taak in een project dat je alleen leest: afvinken of wijzigen kan niet; dat zeggen we in plaats van niets te doen. */
  readOnlyNotice: () => toast(t('readonly.cannotComplete')),

  open(task) {
    return openTaskDialog({ task, store, actions, today: todayString, toggle: handlers.toggle, saveTemplate: (x) => templatesUi().saveTask(x) });
  },

  /** Het venster "Taak toevoegen"; `target` zegt waar de taak standaard komt (project, sectie, of vandaag), anders het huidige scherm. */
  quickAdd(target = null) {
    const context = target ?? (ui.route.type === 'project' ? { projectId: ui.route.id } : ui.route.type === 'today' ? { due: 'today' } : {});
    return openQuickAddDialog({ store, actions, context, onTemplate: (where) => handlers.tasksFromTemplate(where) });
  },

  /** Sjablonen: een project uit een sjabloon, taken uit een sjabloon in een project, en een project of taak als sjabloon bewaren. */
  projectFromTemplate() {
    document.body.classList.remove('nav-open');
    return templatesUi().projectFromTemplate();
  },
  tasksFromTemplate: (where) => templatesUi().tasksFromTemplate(where),

  async removeTask(task) {
    const ok = await confirmDialog({ title: t('task.deleteTitle'), text: t('task.deleteText', { name: task.content }) });
    if (ok) await actions.deleteTask(task.id);
  },

  /** Een andere dag kiezen voor een taak, zonder het taakvenster. */
  async reschedule(task) {
    const picked = await pickDay({ today: todayString(), hasDue: Boolean(task.due) });
    if (picked) await actions.updateTask(task.id, { due: reschedule(task.due, picked.date) });
  },

  /** Lijst, bord of kalender voor een project; bewaard in het project zelf (`view_style`), dus ook op andere apparaten en voor de leden. */
  setViewStyle: (project, style) => actions.updateProject(project.id, { view_style: style }),
  /** Lijst of kalender bij Binnenkort: alleen een voorkeur van dit apparaat. */
  setUpcomingStyle(style) {
    setUpcomingStyle(style);
    render();
  },

  /** Het menu "Verplaats naar…" van een kaart op het bord: naar een andere kolom (sectie) van hetzelfde project. */
  async moveCard(task) {
    const targets = moveTargets(store.view, task);
    const choice = await menuDialog({
      title: t('board.moveTitle', { name: task.content }),
      items: targets.map((x) => ({ value: x.id, label: `${x.name ?? t('board.noSection')}${x.current ? ' ✓' : ''}` })),
    });
    const target = targets.find((x) => x.id === choice);
    if (!target || target.current) return;
    await actions.moveTask(task.id, { project_id: task.project_id, section_id: target.sectionId });
    toast(t('board.moved', { name: task.content, column: target.name ?? t('board.noSection') }));
  },

  /** Een taak toevoegen op een dag van de kalender; `target` zegt in welk project (leeg: de Inbox). */
  addToDay: (day, target = {}) => handlers.quickAdd({ ...target, due: day }),

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
    const edit = mine !== 'viewer'; // een lezer wijzigt niets aan het project (shared/roles.js)
    const choice = await menuDialog({
      title: project.name,
      items: [
        edit && { value: 'edit', label: t('project.editMenu') },
        edit && { value: 'sub', label: t('project.addSub') },
        edit && !isArchivedProject(store.view, project.id) && { value: 'taskTemplate', label: t('template.menu.insert') },
        { value: 'saveTemplate', label: t('template.menu.save') },
        edit && { value: 'favorite', label: project.is_favorite ? t('project.unfavorite') : t('project.favoriteAdd') },
        { value: 'activity', label: t('activity.menu') },
        { value: 'share', label: mine === 'owner' ? t('project.shareMenu') : t('project.members') },
        mine === 'owner' && !isArchivedProject(store.view, project.id) && { value: 'archive', label: t('project.archive') }, // een gearchiveerd project zet je terug (de balk bovenaan)
        mine === 'owner'
          ? { value: 'delete', label: t('project.delete'), danger: true }
          : { value: 'leave', label: t('project.leave'), danger: true },
      ].filter(Boolean),
    });
    if (choice === 'activity') {
      activityUi.open(project);
    } else if (choice === 'edit') {
      await handlers.editProject(project);
    } else if (choice === 'sub') {
      await handlers.addProject(project.id);
    } else if (choice === 'taskTemplate') {
      await handlers.tasksFromTemplate({ projectId: project.id });
    } else if (choice === 'saveTemplate') {
      await templatesUi().saveProject(project);
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
        { value: 'places', label: t('settings.places') },
        { value: 'export', label: t('settings.export') },
        { value: 'templates', label: t('settings.templates') },
        { value: 'sync', label: t('settings.syncNow') },
        { value: 'language', label: t('settings.language') },
        { value: 'logout', label: t('settings.signOut'), danger: true },
      ],
    });
    if (choice === 'sync') sync.requestSync(0);
    else if (choice === 'account') await accountFlow();
    else if (choice === 'notifications') await notificationsDialog({ store, actions, bridge, pushClient });
    else if (choice === 'places') await placesDialog({ store, actions, bridge });
    else if (choice === 'export') await exportDialog({ store, bridge });
    else if (choice === 'templates') await templatesUi().manage();
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
          await attachments.clear();
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
  await attachments.clear(); // ook de bestanden die nog moesten worden geüpload
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
  openTaskDialog({ task, store, actions, today: todayString, saveTemplate: (x) => templatesUi().saveTask(x) });
}

function openPendingTask() {
  if (pendingTaskId && Date.now() - pendingSince > 30_000) pendingTaskId = null; // een taak die niet komt: opgeven
  if (pendingTaskId && store.view.tasks.has(pendingTaskId)) openTaskById(pendingTaskId);
}

function openTaskFromHash() {
  if (openShareFromHash()) return;
  const id = taskIdFromHash(location.hash);
  if (!id) {
    openAddFromHash();
    return;
  }
  history.replaceState(null, '', `${location.pathname}${location.search}`); // het adres weer schoon
  openTaskById(id);
}

// ---------- tekst uit een andere app delen ----------

let pendingShare = null;

/**
 * "Delen naar Tickory" (#share=…): de gedeelde tekst wordt een voorgevuld venster "Taak toevoegen". Is de app nog niet klaar
 * (nog niet ingelogd, eerste sync loopt) of staat er een venster open, dan wacht het tot het kan: je kunt het nog aanpassen of annuleren.
 * @returns {boolean} of dit adres over delen ging
 */
function openShareFromHash() {
  if (!/^#share=/.test(location.hash)) return false;
  const draft = shareFromHash(location.hash);
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  if (draft) {
    pendingShare = draft;
    openPendingShare();
  }
  return true;
}

function openPendingShare() {
  if (!pendingShare || !store.me?.inbox_project_id) return;
  if (document.querySelector('dialog[open]')) return; // het volgende moment (store.subscribe) opnieuw
  const draft = pendingShare;
  pendingShare = null;
  if (!draft.files) {
    handlers.quickAdd({ text: draft.title, description: draft.description });
    return;
  }
  // Gedeelde bestanden: eerst ophalen bij de Android-app, daarna het venster; wordt de taak gemaakt, dan worden het bijlagen.
  fetchSharedFiles(draft).then(async (files) => {
    if (files.length < draft.files.length) toast(t('quick.sharedFilesMissing'), { kind: 'error' });
    const id = await handlers.quickAdd({ text: draft.title, description: draft.description, files: files.map((f) => f.name) });
    if (id && files.length > 0) {
      const { rejected } = await attachments.stage(id, files);
      for (const r of rejected) toast(rejectionText(r), { kind: 'error', timeout: 10_000 });
    }
  });
}

/** De knop "+" van een widget van de Android-app: #add, #add=today of #add=<project-id> opent het venster Taak toevoegen. */
function openAddFromHash() {
  const context = addContextFromHash(location.hash, (id) => store.view.projects.has(id));
  if (!context) return;
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  if (document.querySelector('dialog[open]')) return; // er staat al een venster open
  handlers.quickAdd(Object.keys(context).length > 0 ? context : null);
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
  viewPrefs.persist = !backend.demo; // de demo bewaart niets, ook geen voorkeuren
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
      for (const e of errors) if (!quietCommandError(e)) toast(describeCommandError(e), { kind: 'error', timeout: 10_000 });
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

  // Bijlagen: gekozen bestanden worden lokaal bewaard en geüpload zodra dat kan (core/attachments.js)
  attachments = createAttachmentManager({
    store, actions, api: backend.attachments, getToken, makeId: newId,
    files: backend.demo || !('indexedDB' in window) ? new MemoryFiles() : new IdbFiles(),
  });
  configureAttachments({ manager: attachments, bridge });

  events = backend.listen({ onSyncNeeded: () => sync.requestSync(0), onConnected: () => sync.requestSync(0) });
  store.subscribe(invalidate);
  store.subscribe(maybeSetTimezone);
  store.subscribe(openPendingTask);
  store.subscribe(openPendingShare);
  store.subscribe(() => attachments.process()); // wachtende bestanden gaan door zodra hun taak bij de server is
  watchReminders({ store, bridge }); // Android hoort het zodra er iets aan de meldingen verandert
  watchWidgets({ store, bridge }); // en zodra er iets verandert wat in de widgets staat
  window.addEventListener('online', () => {
    attachments.process();
    events.restart();
    sync.requestSync(0);
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) sync.requestSync(0);
  });
  setInterval(invalidate, 60_000); // "te laat" en de datum van vandaag schuiven mee met de klok

  bindList($('content'), handlers); // het gedrag van alle regels in de takenlijst, met één luisteraar
  installFind({ store, actions, handlers, navigate, getRoute: () => ui.route, persist: !backend.demo }); // zoeken, filters en labels (ui/find.js)
  installInbox({ store, actions, handlers, navigate, getRoute: () => ui.route }); // meldingen bij samenwerken (ui/inbox.js)
  activityUi = installActivity({ store, api, handlers, navigate, getRoute: () => ui.route }); // het activiteitenlogboek van een project (ui/activity.js)
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

  attachments.init().catch(() => {});
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
