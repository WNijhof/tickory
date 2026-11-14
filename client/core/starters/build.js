// Hulpjes om de meegeleverde sjablonen kort op te schrijven (zie nl.js en en.js). Wat eruit komt is gewoon de inhoud van een
// sjabloon zoals in shared/template.js; een test controleert elk sjabloon met dezelfde regels als een geïmporteerd bestand.

/** Een taak: titel, eigenschappen (priority, day, time, recurrence, repeat_text, labels, description) en subtaken. */
export const todo = (content, props = {}, subtasks = []) => ({ content, ...props, ...(subtasks.length > 0 ? { subtasks } : {}) });

/** Een sectie met zijn taken. */
export const section = (name, ...tasks) => ({ name, tasks });

/** Een volledig meegeleverd sjabloon (soort project) met secties; `loose` zijn de taken zonder sectie. */
export const project = ({ id, name, description, color, loose = [], sections = [] }) => ({
  id, kind: 'project', name, description, color, builtin: true, content: { v: 1, tasks: loose, sections },
});

/** Een wekelijkse herhaling op een weekdag (ISO: 1 = maandag … 7 = zondag), beginnend op de eerste zodanige dag vanaf dag 0. */
export const weekly = (isoDay, text) => ({ recurrence: { freq: 'weekly', byweekday: [isoDay] }, repeat_text: text, day: 0 });

/** Een meegeleverd sjabloon voor één taak met subtaken (komt in een bestaand project). */
export const taskTemplate = ({ id, name, description, root }) => ({
  id, kind: 'task', name, description, color: 'charcoal', builtin: true, content: { v: 1, tasks: [root], sections: [] },
});
