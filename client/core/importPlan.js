// Importeren: de tussenvorm uit core/todoistImport.js omzetten in commando's. Per project één reeks (project, opmerkingen bij het
// project, secties, taken met hun subtaken en opmerkingen), in de volgorde waarin de server ze nodig heeft, met volgordesleutels
// die in één keer worden uitgedeeld (`keysAfter`), zodat het optimistisch en zonder verbinding werkt. Vooraf wordt geteld wat het
// kost tegen de grenzen van de server: past het niet, dan wordt er niets aangemaakt. Zie SPEC.md, hoofdstuk 5h.

import { keysAfter } from '../../shared/orderKey.js';
import { APPLY_LIMITS } from '../../shared/template.js';
import { nameKey } from '../../shared/text.js';
import { maxKey, scopeOf } from './reducer.js';
import { allTasks } from './todoistImport.js';

/**
 * De labelnaam zoals hij al bestaat, als dat zo is: hoofdletterongevoelig, en `met_de_auto` (zo schrijft de eigen CSV-export een
 * label met spaties) is het bestaande label "met de auto".
 */
export function canonicalLabel(view, name) {
  return labelFinder(view)(name);
}

/** `canonicalLabel` voor veel namen: de bestaande labels één keer op een rij (een import kan tienduizenden taken hebben). */
function labelFinder(view) {
  const byKey = new Map();
  for (const l of view.labels.values()) if (!byKey.has(nameKey(l.name))) byKey.set(nameKey(l.name), l.name);
  return (name) => byKey.get(nameKey(name)) ?? (name.includes('_') ? byKey.get(nameKey(name.replace(/_/g, ' '))) : undefined) ?? name;
}

/**
 * Welke projecten meegaan, met hun ouders: een project waarvan de ouder niet is gekozen, komt bovenaan (of onder "Uit Todoist").
 * Ouders staan altijd vóór hun kinderen.
 */
export function selectedProjects(projects, selected) {
  const chosen = projects.filter((p) => selected.has(p.key));
  const keys = new Set(chosen.map((p) => p.key));
  const parentOf = (p) => (p.parentKey && keys.has(p.parentKey) ? p.parentKey : null);
  const out = [];
  const placed = new Set();
  const place = (p, guard = 0) => {
    if (placed.has(p.key) || guard > 20) return;
    const parent = parentOf(p);
    if (parent) place(chosen.find((q) => q.key === parent), guard + 1);
    placed.add(p.key);
    out.push({ project: p, parentKey: parent });
  };
  for (const p of chosen) place(p);
  return out;
}

/**
 * De commando's voor een import.
 * @param {object} view de lokale toestand
 * @param {object[]} projects de projecten uit `readImport`
 * @param {{
 *   selected: Set<string>, under: string | null, inboxName: string, makeId: () => string,
 *   resolveLabels: (names: string[]) => { byName: Map<string, string>, commands: object[] },
 * }} options `under`: de naam van een nieuw bovenliggend project ("Uit Todoist"), of null om alles los bovenaan te zetten;
 *   `inboxName`: de naam voor een project "Inbox" dat bovenaan komt (naast de eigen Inbox); `resolveLabels`: labelCommands uit core/actions.js
 * @returns {{ batches: { key: string | null, name: string, commands: object[] }[], rootIds: string[], projectIds: Map<string, string>,
 *   counts: { projects: number (met "Uit Todoist"), imported: number (zonder), sections: number, tasks: number, comments: number, newLabels: number, perProject: { name: string, sections: number, tasks: number, comments: number }[] } }}
 */
export function planImport(view, projects, { selected, under, inboxName, makeId, resolveLabels }) {
  const list = selectedProjects(projects, selected);
  const canonical = labelFinder(view);
  const names = new Map(); // nameKey -> de naam zoals hij wordt (bestaand of nieuw), in volgorde van voorkomen
  for (const { project } of list) {
    for (const task of allTasks(project)) {
      for (const name of task.labels) {
        const found = canonical(name);
        if (!names.has(nameKey(found))) names.set(nameKey(found), found);
      }
    }
  }
  const labels = resolveLabels([...names.values()]);
  const labelId = (name) => labels.byName.get(nameKey(canonical(name)));

  const batches = [];
  const first = [...labels.commands];
  const projectIds = new Map();
  const rootIds = [];
  // volgordesleutels: bovenaan na wat er al staat, en onder elke ouder vanaf het begin
  const topLevel = under ? 1 : list.filter((x) => !x.parentKey).length;
  const topKeys = keysAfter(maxKey(view.projects, scopeOf('project', { parent_id: null })), topLevel);
  let umbrellaId = null;
  if (under) {
    umbrellaId = makeId();
    first.push({ type: 'project_add', args: { id: umbrellaId, name: under, order_key: topKeys[0] } });
    rootIds.push(umbrellaId);
  }
  const childKeys = new Map();
  const nextChildKey = (parentKey) => {
    if (!childKeys.has(parentKey)) {
      const n = list.filter((x) => (x.parentKey ?? null) === parentKey).length;
      childKeys.set(parentKey, { keys: keysAfter(null, n), at: 0 });
    }
    const slot = childKeys.get(parentKey);
    return slot.keys[slot.at++];
  };
  let topAt = 0;
  const perProject = [];
  let sectionsTotal = 0;
  let tasksTotal = 0;
  let commentsTotal = 0;

  for (const { project, parentKey } of list) {
    const commands = batches.length === 0 ? first : [];
    const id = makeId();
    projectIds.set(project.key, id);
    const loose = !parentKey && !under;
    const args = { id, name: loose && nameKey(project.name) === 'inbox' ? inboxName : project.name };
    if (parentKey) {
      args.parent_id = projectIds.get(parentKey);
      args.order_key = nextChildKey(parentKey);
    } else if (under) {
      args.parent_id = umbrellaId;
      args.order_key = nextChildKey(null);
    } else {
      args.order_key = topKeys[topAt++];
      rootIds.push(id);
    }
    if (project.color && project.color !== 'charcoal') args.color = project.color;
    if (project.viewStyle && project.viewStyle !== 'list') args.view_style = project.viewStyle;
    if (project.description) args.description = project.description;
    commands.push({ type: 'project_add', args });
    for (const content of project.comments) commands.push({ type: 'comment_add', args: { id: makeId(), project_id: id, content } });

    const sectionKeys = keysAfter(null, project.sections.length);
    const sectionIds = project.sections.map((section, i) => {
      const sid = makeId();
      const sargs = { id: sid, project_id: id, name: section.name, order_key: sectionKeys[i] };
      if (section.description) sargs.description = section.description;
      if (section.collapsed) sargs.is_collapsed = true;
      commands.push({ type: 'section_add', args: sargs });
      return sid;
    });

    let tasks = 0;
    let comments = project.comments.length;
    const addTasks = (items, sectionId, parentId) => {
      const keys = keysAfter(null, items.length);
      for (const [i, task] of items.entries()) {
        const tid = makeId();
        const targs = { id: tid, project_id: id, content: task.content, order_key: keys[i] };
        if (parentId) targs.parent_id = parentId;
        else if (sectionId) targs.section_id = sectionId;
        if (task.description) targs.description = task.description;
        if (task.priority && task.priority < 4) targs.priority = task.priority;
        const ids = [...new Set(task.labels.map(labelId).filter(Boolean))];
        if (ids.length > 0) targs.labels = ids;
        if (task.due) targs.due = structuredClone(task.due);
        if (task.deadline) targs.deadline = task.deadline;
        if (task.duration) targs.duration = task.duration;
        commands.push({ type: 'task_add', args: targs });
        tasks++;
        for (const content of task.comments) commands.push({ type: 'comment_add', args: { id: makeId(), task_id: tid, content } });
        comments += task.comments.length;
        if (task.subtasks) addTasks(task.subtasks, null, tid);
      }
    };
    addTasks(project.tasks, null, null);
    project.sections.forEach((section, i) => addTasks(section.tasks, sectionIds[i], null));

    batches.push({ key: project.key, name: args.name, commands });
    perProject.push({ name: args.name, sections: project.sections.length, tasks, comments });
    sectionsTotal += project.sections.length;
    tasksTotal += tasks;
    commentsTotal += comments;
  }
  if (batches.length === 0 && first.length > 0) batches.push({ key: null, name: under ?? '', commands: first });

  return {
    batches, rootIds, projectIds,
    counts: { projects: list.length + (under ? 1 : 0), imported: list.length, sections: sectionsTotal, tasks: tasksTotal, comments: commentsTotal, newLabels: labels.commands.length, perProject },
  };
}

/**
 * De eerste grens van de server die deze import zou overschrijden, of null als het past. Telt wat de app lokaal weet (zoals bij
 * sjablonen, core/templates.js): de server blijft leidend en weigert wat de app niet kon zien alsnog per commando.
 * @returns {{ code: 'projects' | 'sections' | 'tasksPerProject' | 'tasksPerUser' | 'labels', limit: number, have: number, need: number, project?: string } | null}
 */
export function importQuotaProblem(view, userId, plan) {
  const over = (code, limit, have, need, project) => (have + need > limit ? { code, limit, have, need, ...(project ? { project } : {}) } : null);
  const owned = [...view.members.values()].filter((m) => m.role === 'owner' && (!userId || m.user_id === userId)).length;
  const problem = over('projects', APPLY_LIMITS.projectsPerUser, owned, plan.counts.projects);
  if (problem) return problem;
  for (const p of plan.counts.perProject) {
    const one = over('sections', APPLY_LIMITS.sectionsPerProject, 0, p.sections, p.name) ?? over('tasksPerProject', APPLY_LIMITS.tasksPerProject, 0, p.tasks, p.name);
    if (one) return one;
  }
  const created = userId ? [...view.tasks.values()].filter((x) => x.creator_id === userId).length : view.tasks.size;
  const mine = (row) => !userId || !row.owner_id || row.owner_id === userId;
  return over('tasksPerUser', APPLY_LIMITS.tasksPerUser, created, plan.counts.tasks)
    ?? over('labels', APPLY_LIMITS.labelsPerUser, [...view.labels.values()].filter(mine).length, plan.counts.newLabels);
}
