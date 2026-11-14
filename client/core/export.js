// Exporteren: al je gegevens als JSON, of de taken van een project (of van alle projecten) als CSV in het sjabloonformaat van
// Todoist (TYPE, CONTENT, DESCRIPTION, PRIORITY, INDENT, AUTHOR, RESPONSIBLE, DATE, DATE_LANG, TIMEZONE), zodat de bestanden ook
// elders te gebruiken zijn. Alles gebeurt op het toestel uit de lokale gegevens: er gaat niets naar een server, het werkt ook
// zonder internet, en je krijgt alleen wat je zelf mag zien (taken van gedeelde projecten, niet van andermans privé-gegevens).
// Bijlagen (de bestanden zelf) zitten er niet in; de lijst van namen wel.

export const EXPORT_FORMAT = 'tickory-export';
export const EXPORT_VERSION = 1;

const CSV_HEADER = ['TYPE', 'CONTENT', 'DESCRIPTION', 'PRIORITY', 'INDENT', 'AUTHOR', 'RESPONSIBLE', 'DATE', 'DATE_LANG', 'TIMEZONE'];

const byKey = (a, b) => (String(a.order_key ?? '') < String(b.order_key ?? '') ? -1 : String(a.order_key ?? '') > String(b.order_key ?? '') ? 1 : String(a.id).localeCompare(String(b.id)));

/**
 * Al je gegevens als één gewoon object (JSON): alle tabellen van de lokale toestand zoals ze nu zijn, met wie de export maakte.
 * @param {Record<string, Map<string, object>>} view de lokale toestand
 * @param {{ username?: string, name?: string } | null} me
 * @param {Date} [now]
 */
export function exportJson(view, me, now = new Date()) {
  const out = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exported_at: now.toISOString(),
    user: me ? { username: me.username ?? null, name: me.name ?? null } : null,
  };
  for (const [resource, rows] of Object.entries(view)) {
    if (!(rows instanceof Map)) continue;
    out[resource] = [...rows.values()].sort((a, b) => String(a.id).localeCompare(String(b.id))).map((r) => ({ ...r }));
  }
  return out;
}

/** Een veld voor CSV: aanhalingstekens waar nodig, en geen formule voor een spreadsheet (een cel die met = + - @ begint krijgt een ' ervoor). */
export function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+([.,]\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvLine = (cells) => cells.map(csvCell).join(',');

/**
 * Rijen voor één project, in de volgorde van de app: eerst de taken zonder sectie, dan per sectie een rij `section` met zijn
 * taken; subtaken staan eronder met INDENT 2 tot en met 4 (dieper wordt 4); opmerkingen komen als rij `note` onder hun taak.
 * @param {Record<string, Map<string, object>>} view
 * @param {string} projectId
 * @param {(userId: string | null | undefined) => string} [nameOf] naam van een gebruiker
 * @returns {string[][]} rijen zonder kopregel
 */
export function projectRows(view, projectId, nameOf = () => '') {
  const rows = [];
  const labelName = (id) => view.labels?.get(id)?.name ?? null;
  const tasks = [...view.tasks.values()].filter((t) => t.project_id === projectId && !t.is_deleted);
  const comments = [...(view.comments?.values() ?? [])].filter((c) => !c.is_deleted && c.task_id).sort((a, b) => String(a.created_at ?? a.id).localeCompare(String(b.created_at ?? b.id)));
  const kids = new Map();
  for (const t of tasks) {
    const key = t.parent_id ?? null;
    if (!kids.has(key)) kids.set(key, []);
    kids.get(key).push(t);
  }
  for (const list of kids.values()) list.sort(byKey);
  const taskRow = (t, depth) => {
    const labels = (t.labels ?? []).map(labelName).filter(Boolean).map((n) => `@${n.replace(/\s+/g, '_')}`);
    const content = labels.length > 0 ? `${t.content} ${labels.join(' ')}` : t.content;
    const due = t.due ? (t.due.string || t.due.date) : '';
    rows.push(['task', content, t.description ?? '', t.priority ?? 4, Math.min(depth, 4), nameOf(t.creator_id), nameOf(t.assignee_id), due, t.due ? (t.due.lang ?? 'nl') : '', '']);
    for (const c of comments) if (c.task_id === t.id) rows.push(['note', c.content ?? '', '', '', '', nameOf(c.author_id), '', '', '', '']);
    for (const child of kids.get(t.id) ?? []) taskRow(child, depth + 1);
  };
  const sections = [...(view.sections?.values() ?? [])].filter((s) => s.project_id === projectId && !s.is_deleted).sort(byKey);
  const ofSection = (id) => (kids.get(null) ?? []).filter((t) => (t.section_id ?? null) === id);
  for (const t of ofSection(null)) taskRow(t, 1);
  for (const s of sections) {
    rows.push(['section', s.name, '', '', '', '', '', '', '', '']);
    for (const t of ofSection(s.id)) taskRow(t, 1);
  }
  return rows;
}

/** De CSV (met kopregel) van één project. */
export function projectCsv(view, projectId, nameOf = () => '') {
  return `${[csvLine(CSV_HEADER), ...projectRows(view, projectId, nameOf).map(csvLine)].join('\r\n')}\r\n`;
}

/** De CSV van alle projecten in één bestand: een extra eerste kolom PROJECT met de naam (en het pad bij subprojecten). */
export function allProjectsCsv(view, nameOf = () => '') {
  const projects = [...view.projects.values()].filter((p) => !p.is_deleted);
  const byId = new Map(projects.map((p) => [p.id, p]));
  const pathOf = (p) => {
    const parts = [];
    for (let cur = p, guard = 0; cur && guard < 10; cur = byId.get(cur.parent_id), guard += 1) parts.unshift(cur.name);
    return parts.join(' / ');
  };
  const lines = [csvLine(['PROJECT', ...CSV_HEADER])];
  for (const p of [...projects].sort(byKey)) {
    for (const r of projectRows(view, p.id, nameOf)) lines.push(csvLine([pathOf(p), ...r]));
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** Een veilige bestandsnaam met de datum, bijvoorbeeld tickory-export-2026-11-14.json of tickory-Huishouden-2026-11-14.csv. */
export function exportFileName(base, ext, now = new Date()) {
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const safe = String(base ?? '').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60);
  return `tickory-${safe ? `${safe}-` : ''}${day}.${ext}`;
}
