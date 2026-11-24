// Wat de desktop-app van je account bijhoudt voor de meldingen van Windows: taken en herinneringen, je instellingen, de meldingen bij
// samenwerken (met de namen van taken, projecten, notities en het begin van opmerkingen) en je notities (voor hun herinneringen).
//
// De eerste keer haalt de app alles op (sync_token "*"); daarna alleen wat er sindsdien veranderde (een delta, zoals de web-app),
// zodat een seintje van de server ("er is iets veranderd") weinig kost. Een verwijdering komt als { id, is_deleted: true }; een
// project waar je niet meer bij kunt komt zo ook, en dan gaat alles erin mee. Voor de zekerheid af en toe toch alles opnieuw
// (FULL_EVERY_MS), en altijd als de server dat zegt (full_sync).

/** De soorten gegevens die de desktop-app vraagt (resource_types van POST /api/v1/sync). */
export const RESOURCES = Object.freeze(['tasks', 'reminders', 'settings', 'notifications', 'notes', 'projects', 'comments']);

/** Zo vaak toch alles opnieuw ophalen, ook als de delta's goed gaan. */
export const FULL_EVERY_MS = 3 * 60 * 60 * 1000;

const alive = (x) => Boolean(x && typeof x === 'object' && typeof x.id === 'string' && !x.is_deleted);

/**
 * Het nieuwe geheel na een antwoord van de server.
 * @param {object | null} prev wat de app had (null: niets, dan moet het antwoord volledig zijn)
 * @param {object} res het antwoord van POST /api/v1/sync
 * @returns {object | null} { sync_token, me, users, tasks, reminders, ... } met alleen wat er nog is; null bij een onbruikbaar antwoord
 */
export function mergeSync(prev, res) {
  if (!res || typeof res !== 'object' || typeof res.sync_token !== 'string') return prev ?? null;
  // een delta zonder iets om op voort te bouwen is niet compleet: dan liever niets (de volgende ronde haalt alles)
  if (!prev && res.full_sync !== true) return null;
  const full = res.full_sync === true;
  const out = {
    sync_token: res.sync_token,
    me: res.me && typeof res.me === 'object' ? res.me : prev?.me ?? null,
    users: Array.isArray(res.users) ? res.users : prev?.users ?? [],
  };
  const lostProjects = new Set();
  for (const key of RESOURCES) {
    const incoming = Array.isArray(res[key]) ? res[key] : [];
    if (full) {
      out[key] = incoming.filter(alive);
      continue;
    }
    const map = new Map((prev[key] ?? []).map((x) => [x.id, x]));
    for (const x of incoming) {
      if (!x || typeof x !== 'object' || typeof x.id !== 'string') continue;
      if (x.is_deleted) {
        map.delete(x.id);
        if (key === 'projects') lostProjects.add(x.id);
      } else {
        map.set(x.id, x);
      }
    }
    out[key] = [...map.values()];
  }
  // Een project dat weg is (verwijderd, of je bent geen lid meer): de taken en opmerkingen erin ook. Daarna wat bij een
  // verdwenen taak hoorde (herinneringen, opmerkingen).
  if (lostProjects.size > 0) {
    out.tasks = out.tasks.filter((x) => !lostProjects.has(x.project_id));
    out.comments = out.comments.filter((c) => !lostProjects.has(c.project_id));
  }
  const tasks = new Set(out.tasks.map((x) => x.id));
  out.reminders = out.reminders.filter((r) => tasks.has(r.task_id));
  out.comments = out.comments.filter((c) => !c.task_id || tasks.has(c.task_id));
  return out;
}

/** Moet deze ronde alles opnieuw? Geen eerdere stand, gevraagd, of te lang geleden. */
export const needsFull = (prev, lastFullAt, now, asked = false) => asked || !prev || now - lastFullAt >= FULL_EVERY_MS;
