// Startpunt van de web-app: verbindt opslag, synchronisatie en scherm.

import { IdbAdapter } from '../core/idb.js';
import { MemoryAdapter, Store } from '../core/store.js';
import { SyncClient } from '../core/syncClient.js';
import { createActions, newId } from '../core/actions.js';
import { createUndo } from '../core/undo.js';
import { addContextFromHash, androidBridge, taskIdFromHash, watchReminders, watchWidgets } from '../core/android.js';
import { fetchSharedFiles, shareFromHash } from '../core/share.js';
import { ApiError, deviceName } from '../core/auth.js';
import { parseSsoHash, ssoErrorText, startSso, takePending } from '../core/sso.js';
import { createBackend } from '../core/backend.js';
import { createPushClient } from '../core/push.js';
import { isArchivedProject, mySettings, roleIn, todayView } from '../core/selectors.js';
import { VIEW_STYLES, moveTargets, viewStyleOf } from '../core/projectViews.js';
import { parseQuickAdd } from '../core/quickadd.js';
import { describeCommandError, quietCommandError } from '../core/messages.js';
import { formatDate, formatDue, nowString, setClockFormat, todayString } from '../core/format.js';
import { planDate } from '../core/bulk.js';
import { dateDialog } from './bulkDialogs.js';
import { createShortcuts, isTyping } from '../core/shortcuts.js';
import { LANGUAGES, getLanguage, setLanguage, t } from '../core/i18n.js';
import { confirmDialog, h, menuDialog, openDialog, promptDialog, replace, toast } from './dom.js';
import { bindList, mainView, sidebar, sidebarHooks } from './render.js';
import { createDragDrop } from './dragdrop.js';
import { installSelection } from './selection.js';
import { installCompleted, isCompletedRoute } from './completed.js';
import { openTaskDialog } from './taskDialog.js';
import { openProjectDialog } from './projectDialog.js';
import { addPastedTasks, openQuickAddDialog, previewChips, suggestSource } from './quickAdd.js';
import { openGeneralDialog } from './generalDialog.js';
import { settingsMenuDialog } from './settingsMenu.js';
import { installSwipe } from './swipe.js';
import { setWeekStart } from '../core/calendar.js';
import { generalOf, startRoute, viewFromHash } from '../../shared/general.js';
import { attachQuickSuggest } from './quickSuggest.js';
import { splitPastedLines } from '../core/quickSuggest.js';
import { archiveDialog, projectCommentsDialog, shortcutsDialog } from './miscDialogs.js';
import { applyPicked, pickDateTime } from './datePopup.js';
import { dueCounts } from '../core/dueCounts.js';
import { accountDialog, adminDialog, loginDialog } from './accountDialogs.js';
import { openShareDialog } from './shareDialog.js';
import { openPendingInvite, takeInviteFromHash } from './inviteLinks.js';
import { createUpdates } from './updates.js';
import { planSectionKey, sectionMoveCommands } from '../core/sectionOrder.js';
import { notificationsDialog } from './reminderUi.js';
import { createAttachmentManager, IdbFiles, MemoryFiles } from '../core/attachments.js';
import { configureAttachments, rejectionText } from './attachments.js';
import { appearanceDialog } from './appearance.js';
import { exportDialog } from './exportDialog.js';
import { allImportable, announceImport, importDialog } from './importDialog.js';
import { applyAppearance, readAppearance } from '../core/theme.js';
import { placesDialog } from './placesUi.js';
import { createTemplatesUi } from './templateUi.js';
import { setUpcomingStyle, upcomingStyle } from './viewSwitch.js';
import { viewPrefs } from './viewPrefs.js';
import { installFind, isFindRoute } from './find.js';
import { installBottomNav } from './bottomNav.js';
import { installNotes, isNotesRoute, noteIdFromHash } from './notes.js';
import { listOptionsDialog } from './listOptionsDialog.js';
import { installInbox } from './inbox.js';
import { installActivity } from './activity.js';
import { installProductivity, isProductivityRoute } from './productivity.js';
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
    if (r && (['today', 'upcoming', 'project'].includes(r.type) || isFindRoute(r) || isCompletedRoute(r) || isProductivityRoute(r) || isNotesRoute(r))) return r;
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
/** Meldingen over een nieuwere versie van de server of de Android-app (ui/updates.js). */
let updates = null;
/** De bijlagen op dit apparaat ook wissen zodra die er zijn (na een vergeten aanmelding, zie boot). */
let forgetFiles = false;
let store;
let sync;
let actions;
let events;
let attachments;
/** Het scherm Activiteit (ui/activity.js). */
let activityUi = null;
/** De stappen die "Ongedaan maken" kan terugdraaien (core/undo.js), en de selectie van meerdere taken (ui/selection.js). */
const undo = createUndo();
let selection;
/** Notities (ui/notes.js): om een notitie te openen vanuit een melding. */
let notesUi = null;
/** Het productiviteitsoverzicht (ui/productivity.js): ook voor de samenvatting boven Vandaag. */
let productivity = null;
/** De menubalk onderaan op een telefoon (ui/bottomNav.js). */
let bottomNav = null;
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
  $('sync-status').title = t('shell.syncTitle');
  $('quick-input').placeholder = t('quick.placeholder');
  $('quick-input').setAttribute('aria-label', t('quick.label'));
  $('quick-add').querySelector('button[type="submit"]').textContent = t('common.add');
}
applyLanguage(); // meteen bij het laden, zodat de Nederlandse terugval in een andere taal niet lang in beeld staat

// ---------- tekenen ----------

/**
 * Tijdens een sleep- of veegbeweging op de tijdlijn of in een lijst (body.hold-render, zie ui/timeline.js en ui/swipe.js) wacht het
 * opnieuw tekenen: anders verdwijnt het element onder je vinger of muis halverwege. Bij het einde (voorval 'hold-render-end') tekent
 * de app bij wat er intussen binnenkwam.
 */
window.addEventListener('hold-render-end', () => { if (ui.heldRender) { ui.heldRender = false; invalidate(); } });
/** Wacht het tekenen nu? Hooguit 15 seconden: een beweging die nooit eindigt (een gemist voorval) houdt het scherm niet vast. */
const renderHeld = () => document.body.classList.contains('hold-render') && Date.now() - Number(document.body.dataset.holdSince ?? 0) < 15_000;

function invalidate() {
  if (renderHeld()) { ui.heldRender = true; return; }
  if (ui.scheduled) return;
  ui.scheduled = true;
  requestAnimationFrame(() => {
    ui.scheduled = false;
    if (renderHeld()) { ui.heldRender = true; return; }
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
  bottomNav?.render();
  const main = mainView({
    view: store.view, route: ui.route, today, now: nowString(),
    showCompleted: ui.route.type === 'project' && ui.showCompleted.has(ui.route.id), handlers,
    me: store.me, userName: (id) => store.userName(id),
  });
  document.body.dataset.route = ui.route.type; // zo kan de stijl per soort scherm iets weglaten (bijvoorbeeld Taak toevoegen bij Notities)
  $('view-title').textContent = main.title;
  $('view-count').textContent = main.count === null ? '' : t('view.count', { count: main.count });
  replace($('view-lead'), main.lead);
  replace($('view-actions'), main.actions);
  document.title = `${main.title} · Tickory`;
  replace($('content'), main.nodes);
  if (focused && document.activeElement === document.body) document.querySelector(`[data-fk="${CSS.escape(focused)}"]`)?.focus();
  renderStatus();
  renderPreview();
  selection?.afterRender({ routeKey: `${ui.route.type}:${ui.route.id ?? ''}` });
}

/** Zo lang bezig of wachtend mag duren voordat de indicator verschijnt: korte opslagmomenten blijven onzichtbaar (geen geknipper). */
const STATUS_QUIET_MS = 4000;
let busySince = 0;
let statusTimer = null;

/**
 * De indicator rechtsboven is er alleen als er iets te melden valt: geen verbinding, aanmelden nodig, een mislukte sync, of een
 * sync/wachtrij die langer dan STATUS_QUIET_MS duurt. Bijgewerkt (alles in orde) en korte opslagmomenten tonen niets.
 */
function renderStatus() {
  const n = store.queueLength;
  const waiting = n > 0 ? t('sync.waiting', { count: n }) : '';
  // Zonder aanmelding is er niets bijgewerkt, ook al is er (nog) geen sync mislukt.
  const state = getToken() ? ui.syncState : 'unauthorized';
  const busy = state === 'syncing' || (state === 'idle' && n > 0);
  if (!busy) busySince = 0;
  else if (!busySince) busySince = Date.now();
  const waited = busy ? Date.now() - busySince : 0;
  const show = busy ? waited >= STATUS_QUIET_MS : state !== 'idle';
  clearTimeout(statusTimer);
  statusTimer = null;
  if (busy && !show) statusTimer = setTimeout(renderStatus, STATUS_QUIET_MS - waited + 50);
  const text = {
    idle: waiting || t('sync.upToDate'),
    syncing: t('sync.syncing'),
    offline: [t('sync.offline'), waiting].filter(Boolean).join(' · '),
    unauthorized: t('sync.signInNeeded'),
    error: t('sync.failed'),
  }[state];
  const el = $('sync-status');
  el.hidden = !show;
  el.textContent = text;
  el.dataset.state = state === 'idle' && n > 0 ? 'pending' : state;
}

// ---------- Instellingen › Algemeen (shared/general.js) ----------

let startApplied = false;
let userNavigated = false;
let appliedSignature = '';
/**
 * Past de algemene voorkeuren toe: de tijdnotatie (core/format.js) en de verborgen onderdelen van de zijbalk (body[data-hide-nav]),
 * en bij het openen van de app één keer de startpagina, zodra je instellingen er zijn en zolang je nog nergens zelf heen ging.
 */
function applyGeneral() {
  if (!store.ready || !store.me) return;
  const general = generalOf(mySettings(store.view, store.userId));
  const signature = JSON.stringify(general);
  if (signature !== appliedSignature) {
    appliedSignature = signature;
    setClockFormat(general.time_format);
    setWeekStart(general.week_start);
    document.body.dataset.hideNav = general.sidebar_hidden.join(' ');
    invalidate();
  }
  if (!startApplied) {
    startApplied = true;
    const route = startRoute(general.start_page, inboxId());
    if (route && !userNavigated && !location.hash) navigate(route);
  }
}

// ---------- snel toevoegen ----------

function quickContext() {
  // in een project dat je alleen leest (core/access.js) kan geen taak: dan gaat ze naar de Inbox, en #project noemt alleen projecten waar het wel kan
  const canAddTo = (id) => canEditProject(store.view, id, store.userId);
  const dates = generalOf(mySettings(store.view, store.userId)).date_recognition; // Instellingen › Algemeen
  if (ui.route.type === 'project' && store.view.projects.has(ui.route.id) && canAddTo(ui.route.id)) return { defaultProjectId: ui.route.id, canAddTo, dates };
  // `string` en `lang` horen bij de datumtaal (wat de herkenner leest), niet bij de taal van de interface: die blijven Nederlands.
  if (ui.route.type === 'today') return { defaultProjectId: inboxId(), defaultDue: { date: todayString(), string: 'vandaag', lang: 'nl' }, canAddTo, dates };
  return { defaultProjectId: inboxId(), canAddTo, dates };
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
  userNavigated = true; // daarna geen startpagina meer: je ging zelf ergens heen
  ui.route = route;
  if (!backend.demo) localStorage.setItem(ROUTE_KEY, JSON.stringify(route));
  document.body.classList.remove('nav-open');
  render();
}

/** Een melding met "Ongedaan maken" voor een stap van `actions.track` (zonder stap, bijvoorbeeld bij een project verwijderen, gewoon de melding). */
function undoToast(text, entry) {
  return selection ? selection.undoToast(text, entry) : toast(text);
}

/** De keuze Lijst, Bord of Kalender voor het venster Weergave (zie ui/listOptionsDialog.js); alleen bij een project en Binnenkort. */
function layoutFor(route) {
  if (route.type === 'project') {
    const project = store.view.projects.get(route.id);
    return project ? { styles: VIEW_STYLES, current: viewStyleOf(project), onChange: (style) => handlers.setViewStyle(project, style) } : null;
  }
  if (route.type === 'upcoming') return { styles: ['list', 'calendar'], current: upcomingStyle(), onChange: (style) => handlers.setUpcomingStyle(style) };
  return null;
}

const handlers = {
  navigate,

  /** Tekent het scherm opnieuw (voor onderdelen met eigen schermtoestand, zoals de gekozen maand van de kalender). */
  refresh: () => render(),

  async toggle(task) {
    if (!canEditProject(store.view, task.project_id, store.userId)) return handlers.readOnlyNotice(task);
    if (task.checked) return actions.track(t('task.completed'), () => actions.uncompleteTask(task.id));
    const { entry } = await actions.track(t('task.completed'), () => actions.completeTask(task.id));
    if (task.due?.recurrence) {
      const next = store.view.tasks.get(task.id);
      return undoToast(next?.due ? t('task.nextTime', { date: formatDue({ date: next.due.date }, todayString()) }) : t('task.completed'), entry);
    }
    return undoToast(t('task.completed'), entry);
  },

  /** Een voltooide taak terugzetten (overzicht Voltooid); een terugkerende taak zegt welke datum hij heeft. */
  async restoreTask(task) {
    if (!canEditProject(store.view, task.project_id, store.userId)) return handlers.readOnlyNotice(task);
    const { entry } = await actions.track(t('completed.restored', { name: task.content }), () => actions.uncompleteTask(task.id));
    const now = store.view.tasks.get(task.id);
    undoToast(now?.due?.recurrence ? t('completed.restoredRecurring', { name: task.content, date: formatDue({ date: now.due.date }, todayString()) }) : t('completed.restored', { name: task.content }), entry);
  },

  /** Ctrl/Cmd+Z: de laatste wijziging ongedaan maken. */
  async undoLast() {
    const item = await actions.undoLast();
    toast(item ? t('undo.done') : t('undo.nothing'));
    selection?.announce(item ? t('undo.done') : t('undo.nothing'));
  },

  /** Een taak in een project dat je alleen leest: afvinken of wijzigen kan niet; dat zeggen we in plaats van niets te doen. */
  readOnlyNotice: () => toast(t('readonly.cannotComplete')),

  open(task) {
    return openTaskDialog({ task, store, actions, today: todayString, toggle: handlers.toggle, onUndoable: undoToast, saveTemplate: (x) => templatesUi().saveTask(x) });
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
    if (!ok) return;
    const { entry } = await actions.track(task.content, () => actions.deleteTask(task.id));
    undoToast(t('undo.taskDeleted', { name: task.content }), entry);
  },

  /** Een andere dag kiezen voor een taak, zonder het taakvenster. */
  async reschedule(task) {
    const picked = await pickDateTime({ today: todayString(), due: task.due, counts: dueCounts(store.view) });
    if (!picked) return;
    const next = applyPicked(task.due, picked);
    if (JSON.stringify(next) === JSON.stringify(task.due ?? null)) return; // niets veranderd
    const { entry } = await actions.track(task.content, () => actions.updateTask(task.id, { due: next }));
    undoToast(next ? t('undo.taskDated', { name: task.content, date: formatDue(next, todayString()) }) : t('undo.taskDatedNone', { name: task.content }), entry);
  },

  /** Sorteren en groeperen van de lijst waar je nu in staat: bewaard bij je instellingen, dus op al je apparaten. */
  viewOptions: (route) => listOptionsDialog({
    route, view: store.view, userId: store.userId, update: (view_options) => actions.updateSettings({ view_options }),
    // Vandaag: je eigen volgorde (slepen) weer weghalen, met ongedaan maken
    clearDayOrder: route.type === 'today' ? () => actions.track(t('listopt.clearDayOrder'), () => actions.updateSettings({ day_order: null })) : null,
    layout: layoutFor(route),
    completed: route.type === 'project' ? { on: ui.showCompleted.has(route.id), toggle: () => handlers.toggleCompleted(route.id) } : null,
  }),

  /** Lijst, bord of kalender voor een project (`view_style`), ook op je andere apparaten; in een gedeeld project alleen voor jezelf (server/projectPrefs.ts). */
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
    const { entry } = await actions.track(task.content, () => actions.moveTask(task.id, { project_id: task.project_id, section_id: target.sectionId }));
    undoToast(t('board.moved', { name: task.content, column: target.name ?? t('board.noSection') }), entry);
  },

  /** Een taak toevoegen op een dag van de kalender; `target` zegt in welk project (leeg: de Inbox). */
  addToDay: (day, target = {}) => handlers.quickAdd({ ...target, due: day }),
  /** Een wijziging vanuit de tijdlijn (ui/timeline.js): een andere tijd of dag, of een andere duur; met "Ongedaan maken". */
  async planTask(task, changes, text) {
    const { entry } = await actions.track(text, () => actions.updateTask(task.id, changes));
    undoToast(text, entry);
  },

  toggleProject: (project) => actions.updateProject(project.id, { is_collapsed: !project.is_collapsed }),
  toggleSection: (section) => actions.updateSection(section.id, { is_collapsed: !section.is_collapsed }),
  toggleTask: (task) => actions.updateTask(task.id, { is_collapsed: !task.is_collapsed }),

  /** De samenvatting boven Vandaag (ui/productivity.js); niets zolang die er nog niet is. */
  todaySummary: (ctx) => productivity?.todaySummary(ctx) ?? null,

  /** "Opnieuw plannen" bij Te laat (Vandaag): alle te late taken die je kunt bewerken naar een gekozen dag; tijd en herhaling blijven. */
  async rescheduleOverdue() {
    const today = todayString();
    const ids = todayView(store.view, today).overdue.filter((x) => canEditProject(store.view, x.project_id, store.userId)).map((x) => x.id);
    if (ids.length === 0) return;
    const picked = await dateDialog({ today, hasDue: false, count: ids.length, title: t('view.rescheduleTitle', { count: ids.length }) });
    if (!picked?.date) return;
    const plan = planDate(store.view, ids, picked.date, (id, changes) => actions.planUpdateTask(id, changes));
    if (plan.commands.length === 0) return;
    const { entry } = await actions.batch(plan.commands, { label: t('view.reschedule') });
    undoToast(t('bulk.doneDate', { count: plan.count, date: formatDate(picked.date, today) }), entry);
  },

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
    if (edited.description !== (project.description ?? '')) changes.description = edited.description;
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
        { value: 'favorite', label: project.is_favorite ? t('project.unfavorite') : t('project.favoriteAdd') }, // persoonlijk, ook voor een lezer
        { value: 'completed', label: t('project.completedMenu') },
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
    } else if (choice === 'completed') {
      navigate({ type: 'completed', id: project.id });
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
    const outcome = await openShareDialog({ store, actions, project, api });
    if (outcome === 'left') navigate({ type: 'project', id: inboxId() });
  },

  async sectionMenu(section) {
    // een plek eerder of later (ook te slepen aan de kop, of Alt + pijl); alleen wat kan
    const earlier = planSectionKey(store.view, section.id, 'up', { userId: store.userId });
    const later = planSectionKey(store.view, section.id, 'down', { userId: store.userId });
    const choice = await menuDialog({
      title: section.name,
      items: [
        { value: 'rename', label: t('common.rename') },
        { value: 'description', label: t('section.descriptionEdit') },
        ...(earlier.plan ? [{ value: 'earlier', label: t('section.moveEarlier') }] : []),
        ...(later.plan ? [{ value: 'later', label: t('section.moveLater') }] : []),
        { value: 'delete', label: t('section.delete'), danger: true },
      ],
    });
    if (choice === 'earlier' || choice === 'later') {
      const r = choice === 'earlier' ? earlier : later;
      const text = t('dnd.sectionMoved', { name: section.name, position: r.position, count: r.count });
      const { entry } = await actions.batch(sectionMoveCommands(store.view, section.id, r.plan), { label: text });
      undoToast(text, entry);
    } else if (choice === 'description') {
      const description = await sectionDescriptionDialog(section);
      if (description !== null && description !== (section.description ?? '')) await actions.updateSection(section.id, { description });
    } else if (choice === 'rename') {
      const name = await promptDialog({ title: t('common.rename'), label: t('common.name'), value: section.name });
      if (name && name !== section.name) await actions.updateSection(section.id, { name });
    } else if (choice === 'delete') {
      const ok = await confirmDialog({ title: t('section.deleteTitle'), text: t('section.deleteText', { name: section.name }) });
      if (!ok) return;
      const { entry } = await actions.track(section.name, () => actions.deleteSection(section.id));
      undoToast(t('undo.sectionDeleted', { name: section.name }), entry);
    }
  },

  toggleCompleted(projectId) {
    if (!ui.showCompleted.delete(projectId)) ui.showCompleted.add(projectId);
    render();
  },

  async settings() {
    if (!store.me) return askLogin();
    // een nieuwere versie van de server (beheerder) of de Android-app staat als regel bovenaan
    const choice = await settingsMenuDialog({ me: store.me, notices: updates?.menuItems() ?? [] });
    if (choice && await updates?.handle(choice)) return undefined;
    if (choice === 'sync') sync.requestSync(0);
    else if (choice === 'general') await openGeneralDialog({ store, actions });
    else if (choice === 'account') await accountFlow();
    else if (choice === 'notifications') await notificationsDialog({ store, actions, bridge, pushClient });
    else if (choice === 'productivity') navigate({ type: 'productivity' });
    else if (choice === 'places') await placesDialog({ store, actions, bridge });
    else if (choice === 'export') await exportDialog({ store, bridge, attachments });
    else if (choice === 'import') announceImport(await importDialog({ store, actions }), navigate);
    else if (choice === 'templates') await templatesUi().manage();
    else if (choice === 'appearance') await appearanceDialog({ persist: !backend.demo });
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
  // koppelen met SSO: naar de inlogdienst en terug (core/sso.js); de terugkeer handelt finishSso af
  const startLink = ({ password, code }) => startSso({ api, purpose: 'link', bridge, storage: localStorage, location, lang: getLanguage(), password, code });
  const next = await accountDialog({ me: store.me, api, startLink });
  if (next === 'admin') {
    await adminDialog({ me: store.me, api, inApp: bridge.available }); // in de Android-app kan een back-up niet worden gedownload
    return accountFlow();
  }
  if (next === 'logout') return logout();
  if (next === 'deleted') return afterAccountDeleted();
  if (next === 'relogin') return askLogin();
  return undefined;
}

/**
 * Het inlogscherm. Lukt het, dan bewaren we het token. Logt er iemand anders in dan wiens gegevens op dit apparaat staan,
 * dan wissen we die eerst (na bevestiging als er nog wijzigingen wachten): gegevens van de één horen nooit bij de ander terecht te komen.
 * Met tweestapsverificatie geeft het wachtwoord eerst alleen een tussentoken; het inlogscherm vraagt dan de code (loginDialog).
 */
/** De keuze "onthoud mij" tussen het wachtwoord en de code (tweestapsverificatie), en bij SSO tot de terugkeer van de inlogdienst. */
let loginRemember = true;
const REMEMBER_KEY = 'tickory.ssoRemember';

async function askLogin(note = '') {
  if (ui.askingLogin) return;
  ui.askingLogin = true;
  try {
    // Hoe kan er op deze server worden ingelogd (wachtwoord, SSO)? Zonder verbinding: gewoon het wachtwoord.
    let methods = { password: true, sso: null };
    try {
      methods = await api.sso.methods();
    } catch { /* offline of een oudere server */ }
    const device = () => deviceName(navigator.userAgent, { app: Boolean(window.TickoryAndroid) });
    await loginDialog({
      username: store.me?.username ?? '',
      note: note || (store.me ? t('login.sessionEnded') : ''),
      sso: methods.sso ?? null,
      passwordLogin: methods.password !== false || !methods.sso,
      // "Onthoud mij": in de Android-app altijd (geen vinkje); bij SSO onthouden we de keuze tot de terugkeer van de inlogdienst
      askRemember: !window.TickoryAndroid,
      onSso: (remember = true) => {
        try { sessionStorage.setItem(REMEMBER_KEY, remember ? '1' : '0'); } catch { /* zonder opslag: dan onthouden */ }
        return startSso({ api, purpose: 'login', bridge, storage: localStorage, location, deviceName: device(), lang: getLanguage() });
      },
      attempt: async (username, password, remember = true) => {
        loginRemember = remember;
        const res = await api.login(username, password, device(), remember);
        return res.two_factor_required ? res : adoptLogin(res, remember);
      },
      attemptCode: async (challenge, code) => {
        const res = await adoptLogin(await api.loginCode(challenge, code), loginRemember);
        if (res.recovery_code_used) toast(t('login.recoveryLeft', { count: res.recovery_codes_left ?? 0 }), { timeout: 12_000 });
        return res;
      },
    });
  } finally {
    ui.askingLogin = false;
  }
}

/**
 * Een gelukte aanmelding overnemen (na het wachtwoord, na de code, of na de terugkeer van SSO). Logt er iemand anders in dan wiens
 * gegevens op dit apparaat staan, dan wissen we die eerst (na bevestiging als er nog wijzigingen wachten): gegevens van de één horen
 * nooit bij de ander terecht te komen.
 */
async function adoptLogin(res, remember = true) {
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
  backend.setToken(res.token, { remember });
  bridge.setSession(res.token);
  if (other) {
    location.reload();
    return res;
  }
  events.restart();
  sync.requestSync(0);
  return res;
}

/**
 * Terug van de inlogdienst (`#oidc=…` of `#oidc-error=…`, zie core/sso.js) of de noodcode van een beheerder (`#signin=…`). De code
 * wordt ingewisseld met het geheim van de poging die hier begon. Geeft null als het gelukt is. Anders `{ note, login }`: bij een
 * poging om in te loggen (`login`) komt de melding op het inlogscherm, bij koppelen als melding in beeld.
 */
async function finishSso(ret) {
  const pending = ret.kind === 'signin' ? null : takePending(localStorage);
  const login = ret.kind === 'signin' || pending?.purpose === 'login' || (!pending && !getToken());
  const fail = (text) => {
    if (!login) toast(text, { kind: 'error', timeout: 12_000 });
    return { note: text, login };
  };
  if (ret.kind === 'error') return fail(ssoErrorText(ret.error));
  if (ret.kind === 'code' && !pending) return fail(ssoErrorText('EXPIRED')); // niet hier begonnen: niet inwisselen
  try {
    let remember = true;
    try { remember = sessionStorage.getItem(REMEMBER_KEY) !== '0'; sessionStorage.removeItem(REMEMBER_KEY); } catch { /* zonder opslag: onthouden */ }
    const res = await api.sso.handoff(ret.code, pending?.binding, remember);
    if (res.linked) {
      toast(t('sso.linkedToast', { name: res.name }), { timeout: 8000 });
      return null;
    }
    await adoptLogin(res);
    return null;
  } catch (err) {
    if (!(err instanceof ApiError)) return null; // geannuleerd bij het wisselen van account
    return fail(err.message);
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
  undo.clear(); // wat de volgende gebruiker niet mag kunnen terugdraaien
  events.stop();
  sync.stop();
  if (usesPush()) await pushClient.disable().catch(() => { /* de server ruimt een aanmelding zonder sessie ook zelf op */ });
  await api.logout().catch(() => { /* zonder verbinding: het token wordt hier toch gewist; intrekken kan later via Account */ });
  bridge.setSession(''); // de Android-app wist dan zijn token en alle geplande herinneringen
  backend.clearToken();
  backend.clearForgotten(); // alles gaat hier al weg
  localStorage.removeItem(ROUTE_KEY);
  if (adapter.clear) await adapter.clear();
  await attachments.clear(); // ook de bestanden die nog moesten worden geüpload
  location.reload();
}

/**
 * Na het verwijderen van je account: alles van dit apparaat wissen (zoals bij afmelden; de server heeft de sessies al ingetrokken)
 * en opnieuw beginnen bij het inlogscherm, met een melding dat het gelukt is.
 */
async function afterAccountDeleted() {
  undo.clear();
  events.stop();
  sync.stop();
  bridge.setSession(''); // de Android-app wist zijn token en alle geplande herinneringen
  backend.clearToken();
  localStorage.removeItem(ROUTE_KEY);
  if (adapter.clear) await adapter.clear();
  await attachments.clear();
  try { sessionStorage.setItem(DELETED_KEY, '1'); } catch { /* zonder opslag: dan zonder melding */ }
  location.reload();
}
const DELETED_KEY = 'tickory.accountDeleted';

/** De beschrijving van een sectie bewerken (met Markdown, zoals bij een project). Geeft de nieuwe tekst, of null bij annuleren. */
function sectionDescriptionDialog(section) {
  return openDialog((finish) => {
    const area = h('textarea', { class: 'field', rows: 4, maxLength: 16000, value: section.description ?? '', placeholder: t('section.descriptionPlaceholder'), dataset: { fk: 'section-description' }, 'aria-label': t('section.descriptionEdit') });
    queueMicrotask(() => area.focus());
    return h('form', { class: 'dialog-form', onsubmit: (e) => { e.preventDefault(); finish(area.value.trim()); } },
      h('h2', {}, t('section.descriptionTitle', { name: section.name })),
      area,
      h('p', { class: 'hint' }, t('section.descriptionHint')),
      h('div', { class: 'dialog-buttons' },
        h('button', { type: 'button', class: 'button', onclick: () => finish(null) }, t('common.cancel')),
        h('button', { type: 'submit', class: 'button button-primary', dataset: { fk: 'section-description-save' } }, t('common.save'))));
  });
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

let pendingPlace = null;
/** Een plek uit het adres openen zodra het kan: de Inbox en een nieuwe notitie wachten op je gegevens (de eerste sync). */
function openPendingPlace() {
  if (!pendingPlace) return;
  if (pendingPlace === 'new-note') {
    if (!store.ready || !store.me || !notesUi) return;
    pendingPlace = null;
    navigate({ type: 'notes' });
    notesUi.newNote();
    return;
  }
  const route = startRoute(pendingPlace, inboxId());
  if (!route) return; // de Inbox: nog niet bekend wie je bent
  pendingPlace = null;
  navigate(route);
}

function openPendingTask() {
  if (pendingTaskId && Date.now() - pendingSince > 30_000) pendingTaskId = null; // een taak die niet komt: opgeven
  if (pendingTaskId && store.view.tasks.has(pendingTaskId)) openTaskById(pendingTaskId);
}

function openTaskFromHash() {
  if (location.hash) userNavigated = true; // een link (melding, snelkoppeling) gaat voor de startpagina
  if (openShareFromHash()) return;
  // een uitnodigingslink (#invite=…): na het inloggen en de eerste sync vragen of je meedoet
  if (takeInviteFromHash()) {
    runInvite();
    return;
  }
  // #view=today …: een snelkoppeling onder het app-icoon (Android) of een bladwijzer; #note=new: een nieuwe notitie
  const view = viewFromHash(location.hash);
  if (view || location.hash === '#note=new') {
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    pendingPlace = view ?? 'new-note';
    openPendingPlace();
    return;
  }
  const noteId = noteIdFromHash(location.hash);
  if (noteId) {
    history.replaceState(null, '', `${location.pathname}${location.search}`); // het adres weer schoon
    notesUi?.openNote(noteId);
    return;
  }
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
/** Een uitnodigingslink afhandelen (ui/inviteLinks.js); doet pas iets als je ingelogd bent en de eerste sync er is. */
function runInvite() {
  if (backend.demo) return;
  openPendingInvite({ api, store, sync, navigate });
}

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
  // waar de taak komt, als de Android-app dat meegaf ("Openen in de app" uit het kleine venster); anders de Inbox
  const where = { projectId: draft.projectId ?? null, sectionId: draft.sectionId ?? null, due: draft.due ?? null };
  if (!draft.files) {
    handlers.quickAdd({ text: draft.title, description: draft.description, ...where });
    return;
  }
  // Gedeelde bestanden: eerst ophalen bij de Android-app, daarna het venster; wordt de taak gemaakt, dan worden het bijlagen.
  fetchSharedFiles(draft).then(async (files) => {
    // een back-up van Todoist (zip), een CSV van Todoist of de eigen export: dan importeren in plaats van een taak met bijlagen
    if (files.length === draft.files.length && await allImportable(files)) {
      announceImport(await importDialog({ store, actions, files }), navigate);
      return;
    }
    if (files.length < draft.files.length) toast(t('quick.sharedFilesMissing'), { kind: 'error' });
    const id = await handlers.quickAdd({ text: draft.title, description: draft.description, ...where, files: files.map((f) => f.name) });
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

/** Thema en accentkleur van dit apparaat: meteen bij het starten, nog eens als alle stylesheets binnen zijn, en mee met het systeem. */
function startAppearance() {
  const apply = () => applyAppearance(document, readAppearance());
  apply();
  window.addEventListener('load', apply, { once: true });
  globalThis.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', apply);
}

async function boot() {
  startAppearance();
  try {
    // In de demo bewaren we niets: elke keer openen begint opnieuw met de voorbeeldgegevens.
    adapter = backend.demo ? new MemoryAdapter() : new IdbAdapter();
    if (adapter.open) await adapter.open();
    // Aangemeld zonder "onthoud mij" en de browser is intussen gesloten: de gegevens op dit apparaat horen weg (core/backend.js)
    if (backend.forgotten()) {
      if (adapter.clear) await adapter.clear();
      localStorage.removeItem(ROUTE_KEY);
      forgetFiles = true;
    }
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
      // weigeringen van een bulkactie worden één melding (ui/selection.js); de rest krijgt zijn eigen melding
      for (const e of selection ? selection.reportErrors(errors) : errors) if (!quietCommandError(e)) toast(describeCommandError(e), { kind: 'error', timeout: 10_000 });
    },
  });

  // andere tabbladen op dit apparaat laten weten dat er lokaal iets is veranderd (ook zonder verbinding)
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('tickory') : null;
  channel?.addEventListener('message', () => store.init());
  updates = createUpdates({ api, store, bridge, demo: backend.demo, getToken });
  actions = createActions(store, {
    requestSync: () => {
      channel?.postMessage('changed');
      sync.requestSync();
    },
    undo,
  });

  // Bijlagen: gekozen bestanden worden lokaal bewaard en geüpload zodra dat kan (core/attachments.js)
  attachments = createAttachmentManager({
    store, actions, api: backend.attachments, getToken, makeId: newId,
    files: backend.demo || !('indexedDB' in window) ? new MemoryFiles() : new IdbFiles(),
  });
  if (forgetFiles) {
    await attachments.clear();
    backend.clearForgotten();
    forgetFiles = false;
  }
  configureAttachments({ manager: attachments, bridge });

  events = backend.listen({ onSyncNeeded: () => sync.requestSync(0), onConnected: () => sync.requestSync(0) });
  store.subscribe(invalidate);
  store.subscribe(maybeSetTimezone);
  store.subscribe(applyGeneral); // Instellingen › Algemeen: tijdnotatie, zijbalk en (één keer) de startpagina
  applyGeneral();
  store.subscribe(openPendingTask);
  store.subscribe(openPendingPlace);
  store.subscribe(openPendingShare);
  store.subscribe(runInvite); // een onthouden uitnodigingslink, zodra je ingelogd bent
  // een nieuwere versie: zodra je bent aangemeld, en daarna af en toe (de controle zelf kijkt hooguit eens per zes uur)
  store.subscribe(() => updates.check());
  setInterval(() => updates.check(), 3_600_000);
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
  selection = installSelection({ content: $('content'), store, actions, handlers }); // meerdere taken kiezen en bewerken (ui/selection.js)
  installSwipe({ content: $('content'), store, handlers }); // vegen op een aanraakscherm: afvinken of een datum (ui/swipe.js)
  installFind({ store, actions, handlers, navigate, getRoute: () => ui.route, persist: !backend.demo }); // zoeken, filters en labels (ui/find.js)
  // het productiviteitsoverzicht (ui/productivity.js): een eigen scherm, en de kop met de cijfers boven Voltooid
  productivity = installProductivity({ store, api, actions, handlers, navigate, getRoute: () => ui.route, persist: !backend.demo });
  installCompleted({ store, handlers, getRoute: () => ui.route, header: productivity.completedHeader, api }); // het overzicht Voltooid (ui/completed.js), direct onder Binnenkort, vóór Meldingen (ui/inbox.js) en Filters en Labels
  installInbox({ store, actions, handlers, navigate, getRoute: () => ui.route, openNote: (id) => notesUi?.openNote(id) }); // meldingen bij samenwerken (ui/inbox.js)
  notesUi = installNotes({ store, actions, handlers, getRoute: () => ui.route, cleanUp: !backend.demo, api }); // notities (ui/notes.js), onder Meldingen
  activityUi = installActivity({ store, api, handlers, navigate, getRoute: () => ui.route }); // het activiteitenlogboek van een project (ui/activity.js)
  // slepen en verplaatsen van taken en projecten, ook met het toetsenbord (ui/dragdrop.js)
  createDragDrop({
    content: $('content'), sidebar: $('sidebar'), actions, selection,
    getContext: () => ({ view: store.view, userId: store.userId, showCompleted: (projectId) => ui.showCompleted.has(projectId) }),
  });
  bottomNav = installBottomNav({ store, handlers, getRoute: () => ui.route, inboxId }); // op een telefoon: de balk onderaan, Bladeren en de "+"
  $('quick-add').addEventListener('submit', submitQuickAdd);
  $('quick-input').addEventListener('input', renderPreview);
  // ook in de balk: suggesties (# / @ {) en meer regels plakken (ui/quickSuggest.js, ui/quickAdd.js)
  const barSuggest = attachQuickSuggest({ input: $('quick-input'), source: () => suggestSource(store, quickContext().defaultProjectId) });
  $('quick-add').after(barSuggest.node);
  $('quick-input').addEventListener('paste', async (e) => {
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (!quickContext().defaultProjectId || splitPastedLines(text).length < 2) return;
    e.preventDefault();
    await addPastedTasks({ view: store.view, actions, text, context: quickContext() });
  });
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
    if (e.key === 'Escape' && document.body.classList.contains('nav-open') && !document.querySelector('dialog[open]')) document.body.classList.remove('nav-open'); // in een venster sluit Escape alleen dat venster
    else if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'z' && !isTyping(e.target) && !document.querySelector('dialog[open]') && store.ready) {
      e.preventDefault(); // buiten invoervelden: de laatste wijziging ongedaan maken (in een invoerveld blijft het eigen "ongedaan maken" van de browser)
      handlers.undoLast();
    } else if (shortcuts.handle(e)) e.preventDefault();
  });

  // De hoogte van de vaste kop (balk en titel) als --head-h, zodat wat eronder vastplakt (de selectiebalk) er netjes onder blijft staan.
  const stickyHead = document.querySelector('.head-sticky');
  if (stickyHead && typeof ResizeObserver === 'function') {
    new ResizeObserver(() => document.documentElement.style.setProperty('--head-h', `${Math.round(stickyHead.getBoundingClientRect().height)}px`)).observe(stickyHead);
  }
  // De terugknop van de Android-app (MainActivity) vraagt eerst of de pagina zelf iets kan sluiten, in deze volgorde: het bovenste venster,
  // Bladeren, de selectie, en een ander scherm dan het hoofdscherm (de startpagina). Pas als dat alles niet zo is, gaat de app naar de achtergrond.
  window.tickoryBack = () => {
    const dialogs = document.querySelectorAll('dialog[open]');
    const top = dialogs[dialogs.length - 1];
    if (top) {
      // zoals Escape: eerst "cancel" (een venster dat niet dicht mag, houdt dat tegen), dan sluiten
      if (top.dispatchEvent(new Event('cancel', { cancelable: true }))) top.close();
      return true;
    }
    if (document.body.classList.contains('nav-open')) {
      document.body.classList.remove('nav-open');
      return true;
    }
    if (document.body.classList.contains('select-mode')) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      return true;
    }
    if (!store.ready || !store.me) return false;
    const home = startRoute(generalOf(mySettings(store.view, store.userId)).start_page, inboxId()) ?? { type: 'today' };
    if (ui.route.type === home.type && (ui.route.id ?? null) === (home.id ?? null)) return false;
    navigate(home);
    return true;
  };

  attachments.init().catch(() => {});
  render();
  document.body.classList.add('ready');
  // terug van de inlogdienst (SSO) of een noodcode: eerst afhandelen, en het fragment meteen uit de adresbalk (en de geschiedenis)
  const ssoReturn = parseSsoHash(location.hash);
  if (ssoReturn) history.replaceState(null, '', location.pathname + location.search);
  const ssoFailed = ssoReturn ? await finishSso(ssoReturn) : null;
  if (getToken() && !ssoFailed?.login) {
    bridge.setSession(getToken()); // bij elke start, ook als de app al was ingelogd
    if (usesPush()) pushClient.refresh().catch(() => {});
    sync.requestSync(0);
  } else {
    let deletedNote = '';
    try {
      if (sessionStorage.getItem(DELETED_KEY)) { deletedNote = t('accountDelete.done'); sessionStorage.removeItem(DELETED_KEY); }
    } catch { /* geen opslag */ }
    askLogin(ssoFailed?.note ?? deletedNote);
  }

  // Een melding aangetikt: de taak openen, via de adresbalk (#task=…, Android en nieuwe vensters) of via de service worker.
  openTaskFromHash();
  window.addEventListener('hashchange', openTaskFromHash);
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.type === 'open-task' && typeof e.data.id === 'string') openTaskById(e.data.id);
    if (e.data?.type === 'open-note' && typeof e.data.id === 'string') notesUi?.openNote(e.data.id);
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
