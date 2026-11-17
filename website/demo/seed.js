// Voorbeeldgegevens voor de demo op de website: een huishouden met een paar gedeelde projecten, in het Nederlands of (in de
// Engelse demo) in het Engels. Beide talen hebben precies dezelfde opbouw, dezelfde datums en dezelfde herhalingen.
//
// LET OP: scripts/build-site.ts zet dit bestand als `demo/core/demoSeed.js` tussen de bestanden van de app. De imports
// hieronder kloppen dus vanaf die plek (naast reducer.js), niet vanaf website/demo/.
//
// De gegevens worden opgebouwd met dezelfde `applyCommand` als waarmee de app rekent, uitgevoerd namens de persoon die
// het zogenaamd deed. Zo heeft elke rij precies de velden en standaardwaarden die de echte server ook zou geven.
// Datums zijn relatief aan vandaag, en de herhalingen komen uit de echte datumherkenner (dateNl.js).

import { applyCommand, emptyState } from './reducer.js';
import { parseDateText } from './dateInput.js';
import { addDays, todayString } from './format.js';
import { isoWeekday, startOfWeek } from './calendar.js';
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
// ---------- de Engelse teksten ----------

/** De Engelse vertaling van elke tekst in de voorbeeldgegevens (namen van projecten, taken, opmerkingen en de geschiedenis). */
const EN = {
  'Huishouden': 'Household',
  'Vakantie Texel': 'Trip to Texel',
  'Fietsroute': 'Cycling route',
  'Verhuizing 2025': 'Moving house 2025',
  'Buurtfeest': 'Street party',
  'Familieweekend': 'Family weekend',
  'Boodschappen': 'Groceries',
  'Klusjes': 'Chores',
  'Vaste prik': 'Routine',
  'Regelen': 'To arrange',
  'Inpakken': 'Packing',
  'bellen': 'calls',
  'boodschappen': 'shopping',
  'buiten': 'outdoors',
  'buurt': 'neighbours',
  'Fietsband plakken': 'Fix the bike tyre',
  'Bibliotheekboeken terugbrengen': 'Return library books',
  'Tandarts bellen voor controle': 'Call the dentist for a check-up',
  'Paspoort verlengen': 'Renew passport',
  'Afspraak maken bij de gemeente. Meenemen: het oude paspoort en een nieuwe pasfoto.': 'Make an appointment at the town hall. Bring the old passport and a new photo.',
  'Verjaardagskaart voor oma sturen': 'Send Grandma a birthday card',
  'Pakketje ophalen bij de buren': 'Pick up the parcel from the neighbours',
  'Weekmenu maken': 'Plan the week\'s meals',
  'Boodschappen doen': 'Do the grocery shopping',
  'Het lijstje hangt op de koelkast. Voor zondag ook iets lekkers halen.': 'The list is on the fridge. Get something nice for Sunday too.',
  'Brood': 'Bread',
  'Melk en eieren': 'Milk and eggs',
  'Koffiebonen': 'Coffee beans',
  'Hagelslag': 'Chocolate sprinkles',
  'Kattenvoer bestellen': 'Order cat food',
  'Lamp in de gang vervangen': 'Replace the hallway light bulb',
  'Kamer opruimen': 'Tidy the bedroom',
  'Dakgoot schoonmaken': 'Clean the gutters',
  'Fietsenschuur opruimen': 'Tidy the bike shed',
  'Oud papier aan de straat': 'Put out the paper recycling',
  'Vuilnis buiten zetten': 'Take out the bins',
  'Planten water geven': 'Water the plants',
  'Stofzuigen': 'Vacuum',
  'Ik haal de koffiebonen op de markt, die hoeven niet van het lijstje.': 'I\'ll get the coffee beans at the market, so they can come off the list.',
  'Top, dank je! Vergeet de hagelslag niet: https://www.voorbeeld.nl/boodschappen': 'Great, thanks! Don\'t forget the sprinkles: https://www.example.com/groceries',
  'Welke fitting is het, E27 of E14?': 'Which fitting is it, E27 or E14?',
  'Wie zet deze week het vuilnis buiten?': 'Who is taking out the bins this week?',
  'Boot reserveren': 'Book the ferry',
  'Huisje aanbetalen': 'Pay the cottage deposit',
  'Oppas voor de kat vragen': 'Ask someone to feed the cat',
  'Regenjassen': 'Rain jackets',
  'Fietstassen': 'Bike panniers',
  'Verrekijker': 'Binoculars',
  'Knooppunten uitzoeken': 'Plan the cycle route',
  'Adreswijziging doorgeven': 'Report the change of address',
  'Vergunning aanvragen bij de gemeente': 'Apply for a permit at the town hall',
  'Partytent regelen': 'Arrange a party tent',
  'Flyers rondbrengen': 'Deliver the flyers',
  'Playlist maken': 'Make a playlist',
  '@Anna, kun jij de partytent van je zus lenen? Dan regel ik de tafels.': '@Anna, could you borrow your sister\'s party tent? Then I\'ll sort out the tables.',
  'Huisje op de Veluwe boeken': 'Book a cottage in the woods',
  'Spelletjes inpakken': 'Pack the board games',
  'Wandelroute uitzoeken': 'Pick a walking route',
  'Ik heb er drie gevonden, ik kies morgen.': 'I found three, I\'ll choose tomorrow.',
  'Rekening van de tandarts betalen': 'Pay the dentist bill',
  'Pakketje terugsturen': 'Send the parcel back',
  'Afspraak bij de kapper maken': 'Book a haircut',
  'Mail van school beantwoorden': 'Reply to the email from school',
  'Verzekeringen vergelijken': 'Compare insurance',
  'Foto\'s van de verjaardag uitzoeken': 'Sort the birthday photos',
  'Abonnement opzeggen': 'Cancel the subscription',
  'Bibliotheekboek verlengen': 'Renew the library book',
  'Cadeau voor Sanne bestellen': 'Order a present for Sanne',
  'Belastingbrief bekijken': 'Read the tax letter',
  'Was ophangen': 'Hang out the washing',
  'Vaatwasser uitruimen': 'Empty the dishwasher',
  'Bed verschonen': 'Change the sheets',
  'Koelkast schoonmaken': 'Clean the fridge',
  'Recept voor zondag zoeken': 'Find a recipe for Sunday',
  'Groente halen bij de markt': 'Buy vegetables at the market',
  'Ramen lappen': 'Clean the windows',
  'Badkamer poetsen': 'Clean the bathroom',
  'Gft-bak buiten zetten': 'Put out the food waste bin',
  'Fietsen nakijken': 'Check the bikes',
  'Weerbericht bekijken': 'Check the weather forecast',
  'Route naar de boot printen': 'Print the route to the ferry',
  'Zwemspullen zoeken': 'Find the swimming things',
  'Campingkaart verlengen': 'Renew the camping card',
  'Buren in de straat uitnodigen': 'Invite the neighbours',
  'Tafels en stoelen tellen': 'Count tables and chairs',
  'Prijzen voor de loterij vragen': 'Ask for raffle prizes',
  'Muziek testen': 'Test the music',
  'Fietsen in de schuur gezet': 'Put the bikes in the shed',
  'Kamer gestofzuigd': 'Vacuumed the bedroom',
  'Opa Kees': 'Grandpa Kees',
};

/**
 * Datums in de Engelse demo. Een herhaling krijgt Engelse tekst die de Engelse herkenner leest (dezelfde regel, zie createSeed met
 * strict); een eenmalige datum blijft precies de dag uit het Nederlands en krijgt deze Engelse tekst erbij.
 */
const EN_DATES = {
  'morgen om 9 uur': 'tomorrow at 9am',
  'volgende week donderdag': 'thursday next week',
  'overmorgen': 'in 2 days',
  'morgen': 'tomorrow',
  'aanstaande zaterdag': 'saturday',
  'elke tweede dinsdag': 'every second tuesday',
  'elke donderdag om 20:00': 'every thursday at 20:00',
  'elke zondag': 'every sunday',
  'elke zaterdag': 'every saturday',
  'aanstaande vrijdag om 10 uur': 'friday at 10am',
  'over twee weken': 'in two weeks',
  'aanstaande vrijdag': 'friday',
  'volgende week': 'in 1 week',
  'over drie weken': 'in 3 weeks',
};

/** De tekst in de gevraagde taal; met `strict` is een ontbrekende vertaling een fout (voor de controle van de website). */
export function seedText(text, language = 'nl', strict = false) {
  if (language !== 'en') return text;
  if (!Object.hasOwn(EN, text)) {
    if (strict) throw new Error(`voorbeeldgegevens: geen Engelse tekst voor "${text}"`);
    return text;
  }
  return EN[text];
}

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

// ---------- wat je de afgelopen weken afvinkte (voor het scherm Productiviteit) ----------

/** Zoveel weken terug gaat de voorbeeldgeschiedenis (het overzicht toont er hooguit 12; het logboek van een server gaat 180 dagen terug). */
const HISTORY_WEEKS = 15;
/** Een vast getal tussen 0 en 1 per tekst (geen Math.random): elke dag krijgt elke keer dezelfde aantallen en tijden. */
function steady(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const DONE_TITLES = {
  inbox: ['Rekening van de tandarts betalen', 'Pakketje terugsturen', 'Afspraak bij de kapper maken', 'Mail van school beantwoorden', 'Verzekeringen vergelijken', "Foto's van de verjaardag uitzoeken", 'Abonnement opzeggen', 'Bibliotheekboek verlengen', 'Cadeau voor Sanne bestellen', 'Belastingbrief bekijken'],
  huis: ['Was ophangen', 'Vaatwasser uitruimen', 'Bed verschonen', 'Koelkast schoonmaken', 'Recept voor zondag zoeken', 'Groente halen bij de markt', 'Ramen lappen', 'Badkamer poetsen', 'Gft-bak buiten zetten'],
  texel: ['Fietsen nakijken', 'Weerbericht bekijken', 'Route naar de boot printen', 'Zwemspullen zoeken', 'Campingkaart verlengen'],
  feest: ['Buren in de straat uitnodigen', 'Tafels en stoelen tellen', 'Prijzen voor de loterij vragen', 'Muziek testen'],
};

/**
 * Een geloofwaardige geschiedenis van afvinkingen in het logboek: op werkdagen meestal 5 tot 9 taken, in het weekend een paar,
 * hier en daar een dag met minder (de reeks breekt), en een rustige vakantieweek. De aantallen hangen alleen af van de datum en
 * van hoeveel weken geleden die is: de demo ziet er elke dag hetzelfde uit en de controle van de website blijft stabiel. Van
 * vandaag staat alleen wat vóór nu gebeurde. Ook Bram en Sanne vinken af (dat telt niet voor jou), en één keer zet je iets terug.
 */
function completionHistory({ now, today, entry, log, state, projects, people, w }) {
  const thisWeek = startOfWeek(today);
  const first = addDays(thisWeek, -7 * HISTORY_WEEKS);
  const origin = new Date(new Date(`${first}T00:00:00Z`).getTime() - 2 * 86_400_000).toISOString();
  // de projecten, secties en vaste taken bestonden al vóór de geschiedenis (in het logboek; de rijen zelf zijn "drie dagen oud")
  const named = (content) => [...state.tasks.values()].find((x) => x.content === content);
  const stofzuigen = named(w('Stofzuigen'));
  const oudPapier = named(w('Oud papier aan de straat'));
  const fietsband = named(w('Fietsband plakken'));
  for (const e of log) {
    if (['project_created', 'member_added', 'section_added'].includes(e.kind) || (e.kind === 'task_added' && (e.task_id === stofzuigen?.id || e.task_id === oudPapier?.id))) e.at = origin;
  }
  const when = (date, minutes) => {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(y, m - 1, d, Math.floor(minutes / 60), minutes % 60).toISOString();
  };
  const nowIso = now.toISOString();
  const add = (projectId, actor, at, ref) => { if (at < nowIso) entry(projectId, actor, 'task_completed', at, ref); };
  for (let date = first; date <= today; date = addDays(date, 1)) {
    const weeksAgo = Math.round((new Date(`${thisWeek}T00:00:00Z`) - new Date(`${startOfWeek(date)}T00:00:00Z`)) / (7 * 86_400_000));
    const weekday = isoWeekday(date);
    const r = steady(date);
    let count;
    if (weeksAgo === 7) count = Math.floor(r * 3); // een vakantieweek: het weekdoel niet gehaald
    else if (weekday <= 5) count = weekday === 3 && [2, 5, 10, 13].includes(weeksAgo) ? 2 + Math.floor(r * 2) : 5 + Math.floor(r * 5);
    else count = Math.floor(r * 4);
    for (let i = 0; i < count; i++) {
      const s = steady(`${date}/${i}`);
      const minutes = 8 * 60 + 10 + Math.floor((i * 13 * 60) / count) + Math.floor(s * 35);
      const pick = steady(`${date}/${i}/p`);
      const kind = pick < 0.3 ? 'inbox' : pick < 0.72 ? 'huis' : pick < 0.88 ? 'texel' : 'feest';
      const titles = DONE_TITLES[kind];
      add(projects[kind], people.anna, when(date, minutes), { task_id: null, title: w(titles[Math.floor(s * titles.length) % titles.length]) });
    }
    // de vaste taken: stofzuigen op zaterdag, oud papier om de week op dinsdag (terugkerend: ze schuiven door en blijven open)
    if (stofzuigen && weekday === 6 && weeksAgo !== 7) add(projects.huis, people.anna, when(date, 10 * 60 + 5), { task_id: stofzuigen.id, title: stofzuigen.content, extra: { recurring: true } });
    if (oudPapier && weekday === 2 && weeksAgo % 2 === 0) add(projects.huis, people.anna, when(date, 19 * 60 + 40), { task_id: oudPapier.id, title: oudPapier.content, extra: { recurring: true } });
    // de anderen in Huishouden
    if (steady(`${date}/b`) < 0.5) add(projects.huis, people.bram, when(date, 18 * 60 + 15), { task_id: null, title: w('Fietsen in de schuur gezet') });
    if (steady(`${date}/s`) < 0.3) add(projects.huis, people.sanne, when(date, 16 * 60 + 30), { task_id: null, title: w('Kamer gestofzuigd') });
  }
  // een vergissing die je meteen herstelde: telt niet mee
  if (fietsband) {
    const date = addDays(today, -2);
    add(projects.inbox, people.anna, when(date, 12 * 60), { task_id: fietsband.id, title: fietsband.content });
    const back = when(date, 12 * 60 + 1);
    if (back < nowIso) entry(projects.inbox, people.anna, 'task_uncompleted', back, { task_id: fietsband.id, title: fietsband.content });
  }
}

/**
 * @param {Date} [now]
 * @param {{ strict?: boolean, language?: 'nl' | 'en' }} [options] strict: een datumtekst die niet herkend wordt, een ontbrekende
 *   vertaling of een Engelse herhaling die anders uitkomt dan de Nederlandse is een fout (voor de controle van de website); anders
 *   krijgt die taak gewoon "over twee dagen", zodat de demo altijd start. language: de taal van de gegevens (standaard Nederlands).
 * @returns {{ state: ReturnType<typeof emptyState>, me: object, users: object[] }}
 */
export function createSeed(now = new Date(), { strict = false, language = 'nl' } = {}) {
  const english = language === 'en';
  const w = (text) => seedText(text, language, strict);
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
    const stamp = time ? `${date}T${time}` : date;
    return english ? { date: stamp, string: stamp, lang: 'en' } : { date: stamp, string: `${d}-${m}-${y}${time ? ` om ${time}` : ''}`, lang: 'nl' };
  };
  /** Een datum in gewone taal, gelezen door de herkenner van de app zelf (in het Engels: zie EN_DATES). */
  const due = (text) => {
    const parsed = parseDateText(text, now, 'nl');
    if (!parsed && strict) throw new Error(`voorbeeldgegevens: de datum "${text}" wordt niet herkend`);
    if (!parsed) return day(2);
    if (!english) return parsed;
    const words = EN_DATES[text];
    if (!words) {
      if (strict) throw new Error(`voorbeeldgegevens: geen Engelse datum voor "${text}"`);
      return { ...parsed, string: parsed.date, lang: 'en' };
    }
    if (!parsed.recurrence) return { date: parsed.date, string: words, lang: 'en' };
    const own = parseDateText(words, now, 'en');
    const same = own && own.date === parsed.date && JSON.stringify(own.recurrence) === JSON.stringify(parsed.recurrence);
    if (!same && strict) throw new Error(`voorbeeldgegevens: "${words}" geeft niet hetzelfde als "${text}"`);
    return same ? own : { ...parsed, string: parsed.date, lang: 'en' };
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
   *   labels?: string[], assignee?: string, description?: string, done?: boolean, duration?: number }} t  `deadline` in dagen vanaf vandaag, `duration` in minuten
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
    if (t.duration) args.duration = t.duration;
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
  const bellen = label(anna, w('bellen'));
  const boodschappen = label(anna, w('boodschappen'));
  const buiten = label(anna, w('buiten'));

  // ---- Inbox: alleen van jou ----
  task(anna, { content: w('Fietsband plakken'), project: INBOX, due: day(-1) });
  task(anna, { content: w('Bibliotheekboeken terugbrengen'), project: INBOX, due: day(-3), priority: 3 });
  const tandarts = task(anna, { content: w('Tandarts bellen voor controle'), project: INBOX, due: due('morgen om 9 uur'), priority: 1, labels: [bellen], duration: 15 });
  const paspoort = task(anna, {
    content: w('Paspoort verlengen'), project: INBOX, deadline: 21, priority: 2,
    description: w('Afspraak maken bij de gemeente. Meenemen: het oude paspoort en een nieuwe pasfoto.'),
  });
  // Herinneringen: de automatische (30 minuten vooraf, zoals de app ze zelf zet bij een taak met een tijd), een dag vooraf,
  // en een herinnering op een eigen tijdstip bij een taak zonder datum.
  reminder(tandarts, { minutes: 30 });
  reminder(tandarts, { minutes: 1440 });
  reminder(tandarts, { at: day(0, '20:00').date });
  reminder(paspoort, { at: day(3, '09:00').date });
  task(anna, { content: w('Verjaardagskaart voor oma sturen'), project: INBOX, due: due('volgende week donderdag') });
  task(anna, { content: w('Pakketje ophalen bij de buren'), project: INBOX, done: true });

  // ---- Huishouden: jouw project, gedeeld met Bram en Sanne ----
  const huis = project(anna, w('Huishouden'), [bram, sanne], { color: 'teal', is_favorite: true });
  const sBoodschappen = section(anna, huis, w('Boodschappen'));
  const sKlusjes = section(anna, huis, w('Klusjes'));
  const sVast = section(anna, huis, w('Vaste prik'));
  task(bram, { content: w('Weekmenu maken'), project: huis, due: day(0), assignee: bram });
  const boodschap = task(anna, { content: w('Boodschappen doen'), project: huis, section: sBoodschappen, due: day(0, '17:30'), assignee: anna, labels: [boodschappen], duration: 45, description: w('Het lijstje hangt op de koelkast. Voor zondag ook iets lekkers halen.') });
  task(anna, { content: w('Brood'), project: huis, parent: boodschap, done: true });
  task(anna, { content: w('Melk en eieren'), project: huis, parent: boodschap });
  task(bram, { content: w('Koffiebonen'), project: huis, parent: boodschap });
  task(sanne, { content: w('Hagelslag'), project: huis, parent: boodschap });
  reminder(boodschap, { minutes: 30 });
  // een herinnering "vooraf" bij een taak zonder tijd doet nog niets (geen belletje) en gaat af zodra de taak een tijd krijgt
  reminder(task(bram, { content: w('Kattenvoer bestellen'), project: huis, section: sBoodschappen, due: due('overmorgen') }), { minutes: 30 });
  task(anna, { content: w('Lamp in de gang vervangen'), project: huis, section: sKlusjes, due: due('morgen'), priority: 2, assignee: bram });
  task(anna, { content: w('Kamer opruimen'), project: huis, section: sKlusjes, due: day(0), assignee: sanne });
  task(bram, { content: w('Dakgoot schoonmaken'), project: huis, section: sKlusjes, due: due('aanstaande zaterdag'), priority: 3, labels: [buiten] });
  task(anna, { content: w('Fietsenschuur opruimen'), project: huis, section: sKlusjes, labels: [buiten] });
  task(anna, { content: w('Oud papier aan de straat'), project: huis, section: sVast, due: due('elke tweede dinsdag') });
  reminder(task(anna, { content: w('Vuilnis buiten zetten'), project: huis, section: sVast, due: due('elke donderdag om 20:00'), assignee: bram }), { minutes: 60 });
  task(anna, { content: w('Planten water geven'), project: huis, section: sVast, due: due('elke zondag'), assignee: sanne });
  task(bram, { content: w('Stofzuigen'), project: huis, section: sVast, due: due('elke zaterdag'), assignee: anna });
  const lamp = [...state.tasks.values()].find((x) => x.content === w('Lamp in de gang vervangen')).id;
  const koffie = comment(bram, { task: boodschap }, w('Ik haal de koffiebonen op de markt, die hoeven niet van het lijstje.'), 150);
  comment(anna, { task: boodschap }, w('Top, dank je! Vergeet de hagelslag niet: https://www.voorbeeld.nl/boodschappen'), 95);
  comment(bram, { task: lamp }, w('Welke fitting is het, E27 of E14?'), 1500);
  const vuilnis = comment(sanne, { project: huis }, w('Wie zet deze week het vuilnis buiten?'), 300);
  const stofzuigen = [...state.tasks.values()].find((x) => x.content === w('Stofzuigen')).id;

  // ---- Vakantie Texel: van jou alleen ----
  const texel = project(anna, w('Vakantie Texel'), [], { color: 'sky' });
  const sRegelen = section(anna, texel, w('Regelen'));
  const sInpakken = section(anna, texel, w('Inpakken'));
  const boot = task(anna, { content: w('Boot reserveren'), project: texel, section: sRegelen, due: due('aanstaande vrijdag om 10 uur'), deadline: 10, priority: 1, duration: 30 });
  reminder(boot, { minutes: 30 });
  reminder(boot, { minutes: 1440 });
  task(anna, { content: w('Huisje aanbetalen'), project: texel, section: sRegelen, due: due('over twee weken') });
  task(anna, { content: w('Oppas voor de kat vragen'), project: texel, section: sRegelen, labels: [bellen] });
  task(anna, { content: w('Regenjassen'), project: texel, section: sInpakken });
  task(anna, { content: w('Fietstassen'), project: texel, section: sInpakken });
  task(anna, { content: w('Verrekijker'), project: texel, section: sInpakken });
  // een subproject, en een project dat al klaar is en daarom gearchiveerd (zie "Gearchiveerde projecten" onderaan de zijbalk)
  const route = project(anna, w('Fietsroute'), [], { color: 'green', parent_id: texel });
  task(anna, { content: w('Knooppunten uitzoeken'), project: route, due: due('over twee weken') });
  const oud = project(anna, w('Verhuizing 2025'), [], { color: 'grey' });
  task(anna, { content: w('Adreswijziging doorgeven'), project: oud, done: true });
  run(anna, 'project_update', { id: oud, is_archived: true });

  // ---- Buurtfeest: van Joost; jij en Mila zijn lid ----
  const feest = project(joost, w('Buurtfeest'), [anna, mila], { color: 'orange' });
  const buurt = label(joost, w('buurt')); // een label van iemand anders: je ziet het, maar kunt het niet wijzigen
  task(joost, { content: w('Vergunning aanvragen bij de gemeente'), project: feest, deadline: 14, priority: 1, assignee: joost, labels: [buurt] });
  const tent = task(joost, { content: w('Partytent regelen'), project: feest, due: due('aanstaande vrijdag'), assignee: anna });
  task(mila, { content: w('Flyers rondbrengen'), project: feest, due: due('volgende week'), assignee: mila, labels: [buurt] });
  task(joost, { content: w('Playlist maken'), project: feest });
  const lenen = comment(mila, { task: tent }, w('@Anna, kun jij de partytent van je zus lenen? Dan regel ik de tafels.'), 40, [anna]);

  // ---- Familieweekend: van Sanne; jij kunt alleen lezen (en reageren) ----
  const weekend = project(sanne, w('Familieweekend'), [bram], { color: 'rose' }, [anna]);
  const huisje = task(sanne, { content: w('Huisje op de Veluwe boeken'), project: weekend, due: due('over drie weken'), priority: 2, assignee: sanne });
  task(bram, { content: w('Spelletjes inpakken'), project: weekend, assignee: bram });
  task(sanne, { content: w('Wandelroute uitzoeken'), project: weekend, due: due('over twee weken') });
  comment(sanne, { task: huisje }, w('Ik heb er drie gevonden, ik kies morgen.'), 600);

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
  completionHistory({ now, today, entry, log, state, projects: { inbox: INBOX, huis, texel, feest }, people: { anna, bram, sanne }, w });
  log.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const activity = log.map((e, i) => ({ id: String(i + 1), ...e }));

  const meRow = DEMO_USERS.find((u) => u.id === DEMO_ME);
  return {
    activity,
    state,
    me: { id: meRow.id, username: meRow.username, name: meRow.name, is_admin: meRow.is_admin, inbox_project_id: INBOX },
    users: DEMO_USERS.map((u) => ({ ...u, name: u.id === 'user-kees' ? w(u.name) : u.name, inbox_project_id: `inbox-${u.id}`, created_at: at })),
  };
}
