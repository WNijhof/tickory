// Voorbeeldgegevens voor de demo op de website: een Nederlands huishouden met een paar gedeelde projecten.
//
// LET OP: scripts/build-site.ts zet dit bestand als `demo/core/demoSeed.js` tussen de bestanden van de app. De imports
// hieronder kloppen dus vanaf die plek (naast reducer.js), niet vanaf website/demo/.
//
// De gegevens worden opgebouwd met dezelfde `applyCommand` als waarmee de app rekent, uitgevoerd namens de persoon die
// het zogenaamd deed. Zo heeft elke rij precies de velden en standaardwaarden die de echte server ook zou geven.
// Datums zijn relatief aan vandaag, en de herhalingen komen uit de echte datumherkenner (dateNl.js).

import { applyCommand, emptyState } from './reducer.js';
import { parseDateText } from './dateNl.js';
import { addDays, todayString } from './format.js';
import { ENTITIES, settingsId } from '../../shared/schema.js';
import { keyAfter } from '../../shared/orderKey.js';

/** Alle accounts op deze denkbeeldige server. `anna` ben jij, en is beheerder. */
export const DEMO_USERS = [
  { id: 'user-anna', username: 'anna', name: 'Anna', is_admin: true, is_disabled: false },
  { id: 'user-bram', username: 'bram', name: 'Bram', is_admin: false, is_disabled: false },
  { id: 'user-sanne', username: 'sanne', name: 'Sanne', is_admin: false, is_disabled: false },
  { id: 'user-joost', username: 'joost', name: 'Joost', is_admin: false, is_disabled: false },
  { id: 'user-mila', username: 'mila', name: 'Mila', is_admin: false, is_disabled: false },
  // heeft een account, maar deelt nog niets met jou: handig om het delen mee te proberen
  { id: 'user-kees', username: 'kees', name: 'Opa Kees', is_admin: false, is_disabled: false },
];
export const DEMO_ME = 'user-anna';
/** De tijdzone van de voorbeeldgebruiker: waarin de (denkbeeldige) server haar herinneringen zou laten afgaan. */
export const DEMO_TIMEZONE = 'Europe/Amsterdam';

const INBOX = `inbox-${DEMO_ME}`;

/** Een rij met alle velden van de entiteit, zoals de server die zou maken. */
function makeRow(entityName, id, values, at) {
  const row = { id };
  for (const c of ENTITIES[entityName].cols) {
    row[c.name] = Object.hasOwn(values, c.name) ? values[c.name] : c.default !== undefined ? (Array.isArray(c.default) ? [...c.default] : c.default) : null;
  }
  return { ...row, is_deleted: false, created_at: at, updated_at: at };
}

/** Maakt iemand lid van een project (wat de server doet bij `project_share`). */
export function addMember(state, projectId, userId, role, at, id) {
  state.members.set(id, makeRow('member', id, { project_id: projectId, user_id: userId, role }, at));
}

/**
 * @param {Date} [now]
 * @param {{ strict?: boolean }} [options] strict: een datumtekst die niet herkend wordt is een fout (voor de controle van
 *   de website); anders krijgt die taak gewoon "over twee dagen", zodat de demo altijd start.
 * @returns {{ state: ReturnType<typeof emptyState>, me: object, users: object[] }}
 */
export function createSeed(now = new Date(), { strict = false } = {}) {
  const state = emptyState();
  const today = todayString(now);
  const at = new Date(now.getTime() - 3 * 86_400_000).toISOString(); // "drie dagen geleden aangemaakt"
  let n = 0;
  const id = (kind) => `demo-${kind}-${String(++n).padStart(4, '0')}`;
  const run = (userId, type, args) => applyCommand(state, { type, args }, at, userId);

  /** Een vaste dag ten opzichte van vandaag, optioneel met een tijdstip. */
  const day = (offset, time = '') => {
    const date = addDays(today, offset);
    const [y, m, d] = date.split('-');
    return { date: time ? `${date}T${time}` : date, string: `${d}-${m}-${y}${time ? ` om ${time}` : ''}`, lang: 'nl' };
  };
  /** Een datum in gewone taal, gelezen door de herkenner van de app zelf. */
  const due = (text) => {
    const parsed = parseDateText(text, now);
    if (!parsed && strict) throw new Error(`voorbeeldgegevens: de datum "${text}" wordt niet herkend`);
    return parsed ?? day(2);
  };

  // ---- de eigen Inbox (bestaat altijd; de server maakt hem aan bij het account) ----
  state.projects.set(INBOX, makeRow('project', INBOX, { name: 'Inbox', order_key: keyAfter(null) }, at));
  addMember(state, INBOX, DEMO_ME, 'owner', at, id('member'));
  // je persoonlijke instellingen (de server maakt die rij zelf aan): de automatische herinnering staat op 30 minuten
  state.settings.set(settingsId(DEMO_ME), makeRow('settings', settingsId(DEMO_ME), { auto_reminder: 30, timezone: DEMO_TIMEZONE, owner_id: DEMO_ME }, at));

  const labels = new Map();
  const label = (owner, name) => {
    const key = `${owner}/${name}`;
    if (!labels.has(key)) {
      labels.set(key, id('label'));
      run(owner, 'label_add', { id: labels.get(key), name });
    }
    return labels.get(key);
  };
  const project = (owner, name, members = [], extra = {}, viewers = []) => {
    const pid = id('project');
    run(owner, 'project_add', { id: pid, name, ...extra });
    for (const m of members) addMember(state, pid, m, 'member', at, id('member'));
    for (const m of viewers) addMember(state, pid, m, 'viewer', at, id('member')); // alleen lezen (shared/roles.js)
    return pid;
  };
  const section = (owner, projectId, name) => {
    const sid = id('section');
    run(owner, 'section_add', { id: sid, project_id: projectId, name });
    return sid;
  };
  /**
   * @param {string} by wie de taak aanmaakte
   * @param {{ content: string, project: string, section?: string, parent?: string, due?: object, deadline?: number, priority?: number,
   *   labels?: string[], assignee?: string, description?: string, done?: boolean }} t  `deadline` in dagen vanaf vandaag
   */
  const task = (by, t) => {
    const tid = id('task');
    const args = { id: tid, project_id: t.project, content: t.content };
    if (t.parent) args.parent_id = t.parent;
    else if (t.section) args.section_id = t.section;
    if (t.due) args.due = t.due;
    if (t.deadline !== undefined) args.deadline = addDays(today, t.deadline);
    if (t.priority) args.priority = t.priority;
    if (t.labels) args.labels = t.labels;
    if (t.assignee) args.assignee_id = t.assignee;
    if (t.description) args.description = t.description;
    run(by, 'task_add', args);
    if (t.done) run(by, 'task_complete', { id: tid });
    return tid;
  };

  /** Een herinnering van jou bij een taak: `minutes` vooraf (0 = op het tijdstip zelf), of `at` (een eigen datum en tijd). */
  const reminder = (taskId, { minutes, at: when }) => {
    run(DEMO_ME, 'reminder_add', { id: id('reminder'), task_id: taskId, ...(when ? { type: 'absolute', due: { date: when } } : { type: 'relative', minute_offset: minutes }) });
  };

  /**
   * Een opmerking bij een taak (`{ task }`) of een project (`{ project }`), `minutesAgo` minuten geleden geschreven door `by`;
   * `mentions` zijn de gebruikers-id's van wie er met @Naam in genoemd wordt.
   */
  const comment = (by, target, content, minutesAgo, mentions = []) => {
    const cid = id('comment');
    run(by, 'comment_add', { id: cid, content, mentions, ...(target.task ? { task_id: target.task } : { project_id: target.project }) });
    const row = state.comments.get(cid);
    if (row) {
      const when = new Date(now.getTime() - minutesAgo * 60_000).toISOString();
      row.created_at = when;
      row.updated_at = when;
    }
    return cid;
  };
  /**
   * Een melding voor jou (wat de server maakt als een ander iets doet, zie server/notify.ts): `kind`, door `by`, over een taak
   * (`{ task }`) of een project (`{ project }`), eventueel bij een opmerking, `minutesAgo` minuten geleden.
   */
  const notification = (by, kind, target, minutesAgo, { comment: commentId = null, read = false } = {}) => {
    const nid = id('notification');
    const when = new Date(now.getTime() - minutesAgo * 60_000).toISOString();
    state.notifications.set(nid, makeRow('notification', nid, {
      kind, actor_id: by, task_id: target.task ?? null, project_id: target.task ? null : target.project, comment_id: commentId, is_read: read, owner_id: DEMO_ME,
    }, when));
  };

  const [anna, bram, sanne, joost, mila] = DEMO_USERS.map((u) => u.id);
  const bellen = label(anna, 'bellen');
  const boodschappen = label(anna, 'boodschappen');
  const buiten = label(anna, 'buiten');

  // ---- Inbox: alleen van jou ----
  task(anna, { content: 'Fietsband plakken', project: INBOX, due: day(-1) });
  task(anna, { content: 'Bibliotheekboeken terugbrengen', project: INBOX, due: day(-3), priority: 3 });
  const tandarts = task(anna, { content: 'Tandarts bellen voor controle', project: INBOX, due: due('morgen om 9 uur'), priority: 1, labels: [bellen] });
  const paspoort = task(anna, {
    content: 'Paspoort verlengen', project: INBOX, deadline: 21, priority: 2,
    description: 'Afspraak maken bij de gemeente. Meenemen: het oude paspoort en een nieuwe pasfoto.',
  });
  // Herinneringen: de automatische (30 minuten vooraf, zoals de app ze zelf zet bij een taak met een tijd), een dag vooraf,
  // en een herinnering op een eigen tijdstip bij een taak zonder datum.
  reminder(tandarts, { minutes: 30 });
  reminder(tandarts, { minutes: 1440 });
  reminder(tandarts, { at: day(0, '20:00').date });
  reminder(paspoort, { at: day(3, '09:00').date });
  task(anna, { content: 'Verjaardagskaart voor oma sturen', project: INBOX, due: due('volgende week donderdag') });
  task(anna, { content: 'Pakketje ophalen bij de buren', project: INBOX, done: true });

  // ---- Huishouden: jouw project, gedeeld met Bram en Sanne ----
  const huis = project(anna, 'Huishouden', [bram, sanne], { color: 'teal', is_favorite: true });
  const sBoodschappen = section(anna, huis, 'Boodschappen');
  const sKlusjes = section(anna, huis, 'Klusjes');
  const sVast = section(anna, huis, 'Vaste prik');
  task(bram, { content: 'Weekmenu maken', project: huis, due: day(0), assignee: bram });
  const boodschap = task(anna, { content: 'Boodschappen doen', project: huis, section: sBoodschappen, due: day(0, '17:30'), assignee: anna, labels: [boodschappen], description: 'Het lijstje hangt op de koelkast. Voor zondag ook iets lekkers halen.' });
  task(anna, { content: 'Brood', project: huis, parent: boodschap, done: true });
  task(anna, { content: 'Melk en eieren', project: huis, parent: boodschap });
  task(bram, { content: 'Koffiebonen', project: huis, parent: boodschap });
  task(sanne, { content: 'Hagelslag', project: huis, parent: boodschap });
  reminder(boodschap, { minutes: 30 });
  // een herinnering "vooraf" bij een taak zonder tijd doet nog niets (geen belletje) en gaat af zodra de taak een tijd krijgt
  reminder(task(bram, { content: 'Kattenvoer bestellen', project: huis, section: sBoodschappen, due: due('overmorgen') }), { minutes: 30 });
  task(anna, { content: 'Lamp in de gang vervangen', project: huis, section: sKlusjes, due: due('morgen'), priority: 2, assignee: bram });
  task(anna, { content: 'Kamer opruimen', project: huis, section: sKlusjes, due: day(0), assignee: sanne });
  task(bram, { content: 'Dakgoot schoonmaken', project: huis, section: sKlusjes, due: due('aanstaande zaterdag'), priority: 3, labels: [buiten] });
  task(anna, { content: 'Fietsenschuur opruimen', project: huis, section: sKlusjes, labels: [buiten] });
  task(anna, { content: 'Oud papier aan de straat', project: huis, section: sVast, due: due('elke tweede dinsdag') });
  reminder(task(anna, { content: 'Vuilnis buiten zetten', project: huis, section: sVast, due: due('elke donderdag om 20:00'), assignee: bram }), { minutes: 60 });
  task(anna, { content: 'Planten water geven', project: huis, section: sVast, due: due('elke zondag'), assignee: sanne });
  task(bram, { content: 'Stofzuigen', project: huis, section: sVast, due: due('elke zaterdag'), assignee: anna });
  const lamp = [...state.tasks.values()].find((x) => x.content === 'Lamp in de gang vervangen').id;
  const koffie = comment(bram, { task: boodschap }, 'Ik haal de koffiebonen op de markt, die hoeven niet van het lijstje.', 150);
  comment(anna, { task: boodschap }, 'Top, dank je! Vergeet de hagelslag niet: https://www.voorbeeld.nl/boodschappen', 95);
  comment(bram, { task: lamp }, 'Welke fitting is het, E27 of E14?', 1500);
  const vuilnis = comment(sanne, { project: huis }, 'Wie zet deze week het vuilnis buiten?', 300);
  const stofzuigen = [...state.tasks.values()].find((x) => x.content === 'Stofzuigen').id;

  // ---- Vakantie Texel: van jou alleen ----
  const texel = project(anna, 'Vakantie Texel', [], { color: 'sky' });
  const sRegelen = section(anna, texel, 'Regelen');
  const sInpakken = section(anna, texel, 'Inpakken');
  const boot = task(anna, { content: 'Boot reserveren', project: texel, section: sRegelen, due: due('aanstaande vrijdag om 10 uur'), deadline: 10, priority: 1 });
  reminder(boot, { minutes: 30 });
  reminder(boot, { minutes: 1440 });
  task(anna, { content: 'Huisje aanbetalen', project: texel, section: sRegelen, due: due('over twee weken') });
  task(anna, { content: 'Oppas voor de kat vragen', project: texel, section: sRegelen, labels: [bellen] });
  task(anna, { content: 'Regenjassen', project: texel, section: sInpakken });
  task(anna, { content: 'Fietstassen', project: texel, section: sInpakken });
  task(anna, { content: 'Verrekijker', project: texel, section: sInpakken });
  // een subproject, en een project dat al klaar is en daarom gearchiveerd (zie "Gearchiveerde projecten" onderaan de zijbalk)
  const route = project(anna, 'Fietsroute', [], { color: 'green', parent_id: texel });
  task(anna, { content: 'Knooppunten uitzoeken', project: route, due: due('over twee weken') });
  const oud = project(anna, 'Verhuizing 2025', [], { color: 'grey' });
  task(anna, { content: 'Adreswijziging doorgeven', project: oud, done: true });
  run(anna, 'project_update', { id: oud, is_archived: true });

  // ---- Buurtfeest: van Joost; jij en Mila zijn lid ----
  const feest = project(joost, 'Buurtfeest', [anna, mila], { color: 'orange' });
  const buurt = label(joost, 'buurt'); // een label van iemand anders: je ziet het, maar kunt het niet wijzigen
  task(joost, { content: 'Vergunning aanvragen bij de gemeente', project: feest, deadline: 14, priority: 1, assignee: joost, labels: [buurt] });
  const tent = task(joost, { content: 'Partytent regelen', project: feest, due: due('aanstaande vrijdag'), assignee: anna });
  task(mila, { content: 'Flyers rondbrengen', project: feest, due: due('volgende week'), assignee: mila, labels: [buurt] });
  task(joost, { content: 'Playlist maken', project: feest });
  const lenen = comment(mila, { task: tent }, '@Anna, kun jij de partytent van je zus lenen? Dan regel ik de tafels.', 40, [anna]);

  // ---- Familieweekend: van Sanne; jij kunt alleen lezen (en reageren) ----
  const weekend = project(sanne, 'Familieweekend', [bram], { color: 'rose' }, [anna]);
  const huisje = task(sanne, { content: 'Huisje op de Veluwe boeken', project: weekend, due: due('over drie weken'), priority: 2, assignee: sanne });
  task(bram, { content: 'Spelletjes inpakken', project: weekend, assignee: bram });
  task(sanne, { content: 'Wandelroute uitzoeken', project: weekend, due: due('over twee weken') });
  comment(sanne, { task: huisje }, 'Ik heb er drie gevonden, ik kies morgen.', 600);

  // ---- Meldingen: wat anderen deden in de gedeelde projecten (de lijst Meldingen, met het belletje) ----
  notification(joost, 'shared', { project: feest }, 3 * 24 * 60, { read: true });
  notification(joost, 'assigned', { task: tent }, 2 * 24 * 60, { read: true });
  notification(sanne, 'comment', { project: huis }, 300, { comment: vuilnis, read: true });
  notification(bram, 'comment', { task: boodschap }, 150, { comment: koffie });
  notification(bram, 'assigned', { task: stofzuigen }, 26 * 60);
  notification(mila, 'mention', { task: tent }, 40, { comment: lenen });

  // ---- het activiteitenlogboek (zoals de server het zou hebben bijgehouden): wie maakte, deelde, voegde toe, vinkte af en reageerde ----
  const log = [];
  const entry = (projectId, actor, kind, when, ref = {}) => log.push({ project_id: projectId, at: when, actor_id: actor, kind, task_id: null, section_id: null, comment_id: null, attachment_id: null, user_id: null, title: null, extra: null, ...ref });
  const ownerOf = (pid) => [...state.members.values()].find((m) => m.project_id === pid && m.role === 'owner')?.user_id ?? DEMO_ME;
  for (const p of state.projects.values()) {
    if (p.id === INBOX) continue;
    const owner = ownerOf(p.id);
    entry(p.id, owner, 'project_created', at, { title: p.name });
    for (const m of state.members.values()) if (m.project_id === p.id && m.role !== 'owner') entry(p.id, owner, 'member_added', at, { user_id: m.user_id, extra: { role: m.role } });
  }
  for (const s of state.sections.values()) entry(s.project_id, ownerOf(s.project_id), 'section_added', at, { section_id: s.id, title: s.name });
  for (const x of state.tasks.values()) {
    entry(x.project_id, x.creator_id, 'task_added', at, { task_id: x.id, title: x.content });
    if (x.checked) entry(x.project_id, x.creator_id, 'task_completed', at, { task_id: x.id, title: x.content });
  }
  for (const c of state.comments.values()) {
    const pid = c.task_id ? state.tasks.get(c.task_id)?.project_id : c.project_id;
    if (pid) entry(pid, c.author_id, 'comment_added', c.created_at, { comment_id: c.id, task_id: c.task_id ?? null, title: c.task_id ? state.tasks.get(c.task_id)?.content : null });
  }
  log.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const activity = log.map((e, i) => ({ id: String(i + 1), ...e }));

  const meRow = DEMO_USERS.find((u) => u.id === DEMO_ME);
  return {
    activity,
    state,
    me: { id: meRow.id, username: meRow.username, name: meRow.name, is_admin: meRow.is_admin, inbox_project_id: INBOX },
    users: DEMO_USERS.map((u) => ({ ...u, inbox_project_id: `inbox-${u.id}`, created_at: at })),
  };
}
