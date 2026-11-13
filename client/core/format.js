// Datums tonen in het Nederlands. Datums zijn zwevend ('YYYY-MM-DD' of 'YYYY-MM-DDTHH:MM'); rekenen gaat in UTC
// zodat zomer- en wintertijd geen rol spelen.

const DAYS = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];
const DAYS_SHORT = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
const MONTHS = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

const pad = (n) => String(n).padStart(2, '0');
const utc = (dateStr) => new Date(`${dateStr.slice(0, 10)}T00:00:00Z`);

/** Vandaag als 'YYYY-MM-DD' in de tijdzone van het apparaat. */
export function todayString(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Het tijdstip van nu als 'YYYY-MM-DDTHH:MM' in de tijdzone van het apparaat. */
export function nowString(now = new Date()) {
  return `${todayString(now)}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export function addDays(dateStr, n) {
  const d = utc(dateStr);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Aantal dagen van `today` tot `dateStr` (negatief = verleden). */
export function daysBetween(today, dateStr) {
  return Math.round((utc(dateStr) - utc(today)) / 86_400_000);
}

/** Korte datum: vandaag, morgen, gisteren, de weekdag (binnen een week), anders "do 19 nov" of "19 nov 2027". */
export function formatDate(dateStr, today) {
  const diff = daysBetween(today, dateStr);
  if (diff === 0) return 'vandaag';
  if (diff === 1) return 'morgen';
  if (diff === -1) return 'gisteren';
  const d = utc(dateStr);
  if (diff > 1 && diff < 7) return DAYS[d.getUTCDay()];
  const base = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return dateStr.slice(0, 4) === today.slice(0, 4) ? `${DAYS_SHORT[d.getUTCDay()]} ${base}` : `${base} ${d.getUTCFullYear()}`;
}

/**
 * Een `due` met de volledige datum ("do 19 nov", "wo 1 jan 2027 14:30"), voor bevestiging bij het invullen. De korte vorm
 * ("donderdag") is in een lijst prettig, maar bij "volgende week donderdag" te vaag om op te vertrouwen.
 */
export function formatDueLong(due, today) {
  if (!due) return '';
  const d = utc(due.date);
  const year = due.date.slice(0, 4) === today.slice(0, 4) ? '' : ` ${d.getUTCFullYear()}`;
  const time = due.date.length > 10 ? ` ${due.date.slice(11, 16)}` : '';
  return `${due.recurrence ? '↻ ' : ''}${DAYS_SHORT[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year}${time}`;
}

/** Kop boven een dag in een overzicht: "Vandaag · wo 11 nov". */
export function formatDayHeading(dateStr, today) {
  const d = utc(dateStr);
  const full = `${DAYS_SHORT[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  const diff = daysBetween(today, dateStr);
  if (diff === 0) return `Vandaag · ${full}`;
  if (diff === 1) return `Morgen · ${full}`;
  return `${DAYS[d.getUTCDay()][0].toUpperCase()}${DAYS[d.getUTCDay()].slice(1)} · ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** Een `due` als korte tekst: "morgen 09:00", "↻ vrijdag". */
export function formatDue(due, today) {
  if (!due) return '';
  const time = due.date.length > 10 ? ` ${due.date.slice(11, 16)}` : '';
  return `${due.recurrence ? '↻ ' : ''}${formatDate(due.date, today)}${time}`;
}

/**
 * Een `due` als tekst voor een invoerveld, in een vorm die de datumherkenner weer kan lezen:
 * een herhaling zoals ze is getypt ("elke vrijdag"), anders "12-11-2026" of "12-11-2026 om 09:00".
 * (Niet de oorspronkelijke tekst: "morgen" van drie dagen geleden zou vandaag iets anders betekenen.)
 */
export function formatDateInput(due) {
  if (!due) return '';
  if (due.recurrence && due.string) return due.string;
  const [y, m, d] = due.date.slice(0, 10).split('-');
  return `${d}-${m}-${y}${due.date.length > 10 ? ` om ${due.date.slice(11, 16)}` : ''}`;
}

/**
 * @returns {'none' | 'overdue' | 'today' | 'future'}
 *   Een taak met tijdstip is pas te laat als dat tijdstip voorbij is; zonder tijdstip pas de dag erna.
 */
export function dueStatus(due, today, now = null) {
  if (!due) return 'none';
  const day = due.date.slice(0, 10);
  if (day < today) return 'overdue';
  if (day > today) return 'future';
  if (now && due.date.length > 10 && due.date.slice(0, 16) < now) return 'overdue';
  return 'today';
}
