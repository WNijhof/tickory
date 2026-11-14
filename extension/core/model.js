// Het model van het venster "Opslaan in Tickory", als gewone gegevens: wat er voorgevuld wordt (titel, beschrijving), welke projecten
// in de keuzelijst staan, wat de snelle invoer in de titel herkent, en welke commando's er naar de server gaan. Zonder browser-API's;
// de herkenner van de web-app (client/core/quickadd.js) komt als functie binnen, zodat dit in node te testen is met de echte.

const MAX_TITLE = 200; // een titel is een korte regel (zoals bij Delen naar Tickory, client/core/share.js)
const MAX_CONTENT = 4000; // de grens van het veld
const MAX_DESCRIPTION = 16_000;
const MAX_QUOTE = 4000;
const MAX_URL = 4000;
const FLOATING = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/; // een datum met tijd (shared/reminders.js)
const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
/** Staat tijdens het herkennen op de plek van de letterlijke titel: een teken uit het privégebied, dat in geen enkele tekst voorkomt. */
const HOLDER = '';

/** Tekst zonder stuurtekens (wel regeleinden), in NFC. */
const clean = (v) => (typeof v === 'string' ? v.normalize('NFC').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim() : '');
const oneLine = (v) => clean(v).replace(/\s+/g, ' ');

/** Kapt af op een woordgrens (of anders hard), zonder een emoji doormidden te breken. */
export function shorten(text, max) {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  const at = cut.lastIndexOf(' ');
  return `${(at > max / 2 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

/** Een adres dat in een taak thuishoort: alleen http(s), zonder inloggegevens erin; anders ''. */
export function usableUrl(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_URL) return '';
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  url.username = '';
  url.password = '';
  return url.href;
}

/**
 * Titel en beschrijving uit wat de browser over de pagina weet.
 * @param {{ pageUrl?: string, pageTitle?: string, linkUrl?: string, linkText?: string, selectionText?: string }} ctx
 *   een link (contextmenu op een link): de link wordt de taak; anders de pagina. Geselecteerde tekst komt als citaat in de beschrijving.
 * @param {(key: string, subs?: string[]) => string} msg
 * @returns {{ title: string, description: string }}
 */
export function contextDraft(ctx, msg) {
  const page = usableUrl(ctx?.pageUrl);
  const link = usableUrl(ctx?.linkUrl);
  const selection = clean(ctx?.selectionText).replace(/\n{3,}/g, '\n\n');
  let title;
  const lines = [];
  if (link) {
    title = oneLine(ctx.linkText) || link;
    lines.push(link);
    if (page && page !== link) lines.push('', msg('descFoundOn', [page]));
  } else {
    title = oneLine(ctx?.pageTitle) || page;
    if (page) lines.push(page);
  }
  if (selection) {
    const quoted = shorten(selection, MAX_QUOTE).split('\n').map((l) => (l.trim() ? `> ${l.trimEnd()}` : '>'));
    if (lines.length) lines.push('');
    lines.push(...quoted);
    if (!title) title = oneLine(selection.split('\n')[0]);
  }
  return { title: shorten(title, MAX_TITLE), description: lines.join('\n').slice(0, MAX_DESCRIPTION) };
}

/** Hoe lang een keuze uit het contextmenu geldt: het venster opent meteen daarna, een oude keuze hoort bij een andere klik. */
export const PENDING_MS = 60_000;

/**
 * De keuze uit het contextmenu (link, selectie of pagina), als die vers is en bij dit tabblad hoort; anders null (dan geldt de pagina
 * in het tabblad zelf).
 */
export function usePending(pending, { now, tabId = null }) {
  if (!pending || typeof pending !== 'object' || typeof pending.at !== 'number') return null;
  if (now - pending.at > PENDING_MS || pending.at > now + 5000) return null;
  if (tabId !== null && pending.tabId !== null && pending.tabId !== undefined && pending.tabId !== tabId) return null;
  return pending;
}

/** Is het project (of een project erboven) gearchiveerd? */
function archived(byId, id) {
  let p = byId.get(id);
  for (let i = 0; p && i < 1000; i++) {
    if (p.is_archived) return true;
    p = p.parent_id ? byId.get(p.parent_id) : undefined;
  }
  return false;
}

/**
 * Wat de extensie van een sync-antwoord bewaart: de projecten (zonder gearchiveerde, met of je ze alleen leest), secties, labels
 * en de automatische herinnering uit de instellingen. Geen taken: die heeft de extensie niet nodig.
 */
export function listsFromSync(res) {
  const me = res?.me ?? {};
  const alive = (rows) => (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.id === 'string' && !r.is_deleted);
  const all = alive(res?.projects);
  const byId = new Map(all.map((p) => [p.id, p]));
  const viewer = new Set(alive(res?.members).filter((m) => m.user_id === me.id && m.role === 'viewer').map((m) => m.project_id));
  const projects = all.filter((p) => !archived(byId, p.id)).map((p) => ({
    id: p.id, name: String(p.name ?? ''), parent_id: p.parent_id ?? null, order_key: String(p.order_key ?? ''), inbox: p.id === me.inbox_project_id, readOnly: viewer.has(p.id),
  }));
  const settings = alive(res?.settings).find((s) => s.owner_id === me.id || s.id === `settings-${me.id}`);
  return {
    user: { id: me.id, username: me.username, name: me.name },
    inboxId: me.inbox_project_id ?? null,
    projects,
    sections: alive(res?.sections).filter((s) => !s.is_archived).map((s) => ({ id: s.id, project_id: s.project_id, name: String(s.name ?? ''), order_key: String(s.order_key ?? '') })),
    labels: alive(res?.labels).map((l) => ({ id: l.id, name: String(l.name ?? ''), owner_id: l.owner_id ?? null })),
    autoReminder: Number.isInteger(settings?.auto_reminder) ? settings.auto_reminder : 30,
  };
}

/**
 * De keuzelijst: de Inbox eerst, daarna de boom op volgorde (`depth` voor het inspringen). Een project dat je alleen leest staat
 * erin (de boom blijft heel) maar is niet te kiezen.
 * @returns {{ id: string, name: string, depth: number, disabled: boolean }[]}
 */
export function projectOptions(lists) {
  const projects = lists?.projects ?? [];
  const known = new Set(projects.map((p) => p.id));
  const byOrder = (a, b) => (a.order_key < b.order_key ? -1 : a.order_key > b.order_key ? 1 : a.id < b.id ? -1 : 1);
  const children = new Map();
  for (const p of projects) {
    if (p.inbox) continue;
    const parent = p.parent_id && known.has(p.parent_id) ? p.parent_id : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(p);
  }
  const out = projects.filter((p) => p.inbox).map((p) => ({ id: p.id, name: p.name, depth: 0, disabled: p.readOnly }));
  const seen = new Set();
  const walk = (parent, depth) => {
    for (const p of (children.get(parent) ?? []).sort(byOrder)) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      out.push({ id: p.id, name: p.name, depth, disabled: p.readOnly });
      walk(p.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** Het project waarin een nieuwe taak komt als de gebruiker niets kiest: het laatst gekozen project als dat nog kan, anders de Inbox. */
export function defaultProject(lists, remembered) {
  const usable = (id) => (lists?.projects ?? []).some((p) => p.id === id && !p.readOnly);
  if (remembered && usable(remembered)) return remembered;
  return lists?.inboxId ?? null;
}

/**
 * Welk deel van de titel nog precies de voorgevulde paginatitel is. Dat deel blijft letterlijk staan: een pagina die
 * "Morgen gratis parkeren - NOS" heet, wordt geen taak voor morgen. Wat de gebruiker erachter typt ("… vrijdag p1") herkent de
 * snelle invoer wel. Het letterlijke deel eindigt op een woordgrens.
 */
export function splitLiteral(text, prefilled) {
  if (!prefilled || !text) return { literal: '', rest: text ?? '' };
  let n = 0;
  const max = Math.min(text.length, prefilled.length);
  while (n < max && text[n] === prefilled[n]) n++;
  if (n < text.length && n > 0 && !/\s/.test(text[n]) && !/\s/.test(text[n - 1])) {
    // midden in een woord: terug tot na de laatste spatie (de rest van het woord hoort bij wat de gebruiker typte)
    n = Math.max(text.lastIndexOf(' ', n - 1), text.lastIndexOf('\t', n - 1)) + 1;
  }
  return { literal: text.slice(0, n), rest: text.slice(n) };
}

/**
 * De titel lezen met de snelle invoer van Tickory (`morgen`, `p1`, `#project`, `/sectie`, `@label`, `!30m`, `=1u`), behalve het
 * letterlijke deel uit de paginatitel.
 * @param {string} text
 * @param {{ parse: Function, lists: object, prefilled?: string, defaultProjectId: string, now?: Date }} options `parse` is parseQuickAdd
 */
export function readTitle(text, { parse, lists, prefilled = '', defaultProjectId, now = new Date() }) {
  const { literal, rest } = splitLiteral(text, prefilled);
  const view = {
    projects: new Map((lists?.projects ?? []).map((p) => [p.id, p])),
    sections: new Map((lists?.sections ?? []).map((s) => [s.id, s])),
    labels: new Map((lists?.labels ?? []).map((l) => [l.id, l])),
  };
  const writable = new Set((lists?.projects ?? []).filter((p) => !p.readOnly).map((p) => p.id));
  // De herkenner laat een titel die alleen uit een datum bestaat staan ("morgen" wordt geen lege taak voor morgen). Hier is het
  // letterlijke deel de titel: een plaatshouder ervoor zorgt dat "Artikel" + " morgen" wel een taak voor morgen wordt.
  const parsed = parse(literal ? `${HOLDER} ${rest}` : rest, { view, now, defaultProjectId, canAddTo: (id) => writable.has(id) });
  const content = `${literal} ${parsed.content.replace(HOLDER, '')}`.normalize('NFC').replace(/\s+/g, ' ').trim();
  return { ...parsed, content: content.slice(0, MAX_CONTENT) };
}

/** Een herinnering in woorden: "herinnering 2 uur vooraf", "herinnering op het tijdstip", "herinnering 2026-11-20 08:00". */
function reminderText(r, msg) {
  if (r.type === 'absolute') return msg('chipReminderAt', [r.due.date.replace('T', ' ')]);
  const m = r.minute_offset;
  if (m === 0) return msg('chipReminderNow');
  if (m % 1440 === 0) return msg('chipReminderDays', [String(m / 1440)]);
  if (m % 60 === 0) return msg('chipReminderHours', [String(m / 60)]);
  return msg('chipReminderMinutes', [String(m)]);
}

/** Wat de herkenning in de titel vond, als korte stukjes voor onder het invoerveld. */
export function previewChips(parsed, lists, { defaultProjectId, now = new Date(), locale = 'nl-NL', msg }) {
  const chips = [];
  if (parsed.due?.date) {
    const [y, m, d] = parsed.due.date.slice(0, 10).split('-').map(Number);
    const day = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    const time = FLOATING.test(parsed.due.date) ? ` ${parsed.due.date.slice(11, 16)}` : '';
    const said = parsed.due.string ? `${parsed.due.string} · ` : '';
    chips.push({ kind: 'due', text: `${said}${day}${time}${parsed.due.recurrence ? ' ↻' : ''}` });
  }
  if (parsed.deadline) chips.push({ kind: 'deadline', text: msg('chipDeadline', [parsed.deadline]) });
  if (parsed.priority && parsed.priority < 4) chips.push({ kind: 'priority', text: `P${parsed.priority}` });
  if (parsed.project_id && parsed.project_id !== defaultProjectId) {
    const p = lists?.projects?.find((x) => x.id === parsed.project_id);
    if (p) chips.push({ kind: 'project', text: `#${p.name}` });
  }
  if (parsed.section_id) {
    const s = lists?.sections?.find((x) => x.id === parsed.section_id);
    if (s) chips.push({ kind: 'section', text: `/${s.name}` });
  }
  for (const id of parsed.labels ?? []) {
    const l = lists?.labels?.find((x) => x.id === id);
    if (l) chips.push({ kind: 'label', text: `@${l.name}` });
  }
  for (const name of parsed.newLabels ?? []) chips.push({ kind: 'label', text: msg('chipNewLabel', [name]) });
  for (const r of parsed.reminders ?? []) chips.push({ kind: 'reminder', text: reminderText(r, msg) });
  if (parsed.duration) chips.push({ kind: 'duration', text: msg('chipDuration', [String(parsed.duration)]) });
  return chips;
}

/** Een willekeurig stuk tekst voor id's (`makeRandom` is voor tests). */
export function randomBase(makeRandom = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  let s = '';
  for (const b of makeRandom(16)) s += ID_ALPHABET[b % 64];
  return s;
}

/**
 * Eén poging om op te slaan: vaste id's en uuid's, afgeleid van één willekeurige basis. Mislukt het versturen (geen verbinding,
 * te lang geen antwoord), dan gaat dezelfde poging opnieuw: de server voert een uuid hooguit één keer uit, dus er komt nooit een
 * dubbele taak. Weigert de server een commando, dan bewaart hij die uitkomst bij de uuid; een volgende poging krijgt daarom een
 * nieuwe basis (zie nextAttempt).
 */
export function newAttempt(base = randomBase()) {
  return {
    base,
    id: (part) => `${base}${part}`.slice(0, 40),
    uuid: (part) => `ext-${base}-${part}`,
  };
}

/** Na een uitkomst: dezelfde poging houden (alleen als er niets is aangekomen of beslist) of een nieuwe. */
export function nextAttempt(attempt, outcome, makeBase = randomBase) {
  return outcome.retrySame ? attempt : newAttempt(makeBase());
}

/**
 * De commando's voor de nieuwe taak: eerst nieuwe labels, dan de taak, dan herinneringen (de opgegeven, of de automatische als de
 * taak een tijd heeft; zoals de web-app, client/core/actions.js).
 */
export function buildCommands(parsed, { description = '', attempt, autoReminder = 30 }) {
  const commands = [];
  const labels = [...(parsed.labels ?? [])];
  (parsed.newLabels ?? []).forEach((name, i) => {
    const id = attempt.id(`L${i}`);
    commands.push({ type: 'label_add', uuid: attempt.uuid(`label${i}`), args: { id, name: name.normalize('NFC') } });
    labels.push(id);
  });
  const taskId = attempt.id('T');
  const args = { id: taskId, project_id: parsed.project_id, content: parsed.content };
  const desc = clean(description).slice(0, MAX_DESCRIPTION);
  if (desc) args.description = desc;
  if (parsed.section_id) args.section_id = parsed.section_id;
  if (parsed.priority && parsed.priority !== 4) args.priority = parsed.priority;
  if (labels.length) args.labels = [...new Set(labels)];
  if (parsed.due) args.due = parsed.due;
  if (parsed.deadline) args.deadline = parsed.deadline;
  if (parsed.duration) args.duration = parsed.duration;
  commands.push({ type: 'task_add', uuid: attempt.uuid('task'), args });
  const given = parsed.reminders ?? [];
  const specs = given.length ? given : FLOATING.test(parsed.due?.date ?? '') && autoReminder >= 0 ? [{ type: 'relative', minute_offset: autoReminder }] : [];
  specs.forEach((spec, i) => {
    const base = { id: attempt.id(`R${i}`), task_id: taskId };
    commands.push({
      type: 'reminder_add', uuid: attempt.uuid(`reminder${i}`),
      args: spec.type === 'absolute' ? { ...base, type: 'absolute', due: { date: spec.due.date } } : { ...base, type: 'relative', minute_offset: spec.minute_offset },
    });
  });
  return commands;
}

/**
 * De uitkomst van een verzoek (of de fout als het verzoek niet aankwam).
 * @returns {{ ok: true, warning: string | null } | { ok: false, code: string, retrySame: boolean, error?: unknown }}
 */
export function outcomeOf(commands, response, error = null) {
  if (error) {
    // niets aangekomen, of geen antwoord: dezelfde poging mag opnieuw (de server herkent de uuid's)
    const retrySame = ['OFFLINE', 'TIMEOUT', 'BUSY'].includes(error.code) || /^HTTP_5/.test(error.code ?? '') || error.status >= 500;
    return { ok: false, code: error.code ?? 'UNKNOWN', retrySame, error };
  }
  const status = response?.sync_status ?? {};
  const task = commands.find((c) => c.type === 'task_add');
  const result = status[task?.uuid];
  if (result === 'ok') {
    const failed = commands.find((c) => c.type !== 'task_add' && status[c.uuid] !== 'ok');
    return { ok: true, warning: failed ? (status[failed.uuid]?.error_code ?? 'UNKNOWN') : null };
  }
  // een label dat niet aangemaakt kon worden, laat de taak ook mislukken: noem de eerste fout in de reeks
  const first = commands.map((c) => status[c.uuid]).find((r) => r && r !== 'ok');
  return { ok: false, code: first?.error_code ?? 'UNKNOWN', retrySame: false };
}
