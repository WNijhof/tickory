// Hoeveel open taken er op elke dag staan (voor de stipjes en het bijschrift in de datumkiezer, ui/datePopup.js).
// Een taak met een tijd telt op haar dag; afgevinkte taken en taken zonder datum tellen niet.

/**
 * @param {{ tasks: Map<string, { checked?: boolean, due?: { date?: string } | null }> }} view
 * @returns {Map<string, number>} dag 'YYYY-MM-DD' naar het aantal open taken
 */
export function dueCounts(view) {
  const counts = new Map();
  for (const task of view.tasks.values()) {
    const date = task.due?.date;
    if (task.checked || typeof date !== 'string' || date.length < 10) continue;
    const day = date.slice(0, 10);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return counts;
}
