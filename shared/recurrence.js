// Herhalingen: bepaalt de volgende datum van een terugkerende taak. Gedeeld door server en client:
// de client rekent hiermee optimistisch (ook offline), de server is leidend.
//
// De natuurlijke-taalkant ("elke maandag") zit in de client; hier staat alleen de gestructureerde regel.
// Datums zijn "zwevend": 'YYYY-MM-DD' of 'YYYY-MM-DDTHH:MM(:SS)' zonder tijdzone. Het tijdgedeelte blijft behouden.

/**
 * @typedef {{
 *   freq: 'daily' | 'weekly' | 'monthly' | 'yearly',
 *   interval?: number,      // elke n-de dag/week/maand/jaar; standaard 1
 *   byweekday?: number[],   // weekly: ISO-weekdagen, 1 = maandag … 7 = zondag; monthly met nth: precies één weekdag
 *   bymonthday?: number,    // alleen monthly/yearly: vaste dag van de maand (1-31), ingekort op korte maanden
 *   nth?: number,           // alleen monthly, met één weekdag: 1-4 = "elke eerste … vierde dinsdag van de maand", -1 = de laatste
 *   fromCompletion?: true,  // "elke! 3 dagen": de volgende keer telt vanaf de dag dat je afvinkt, niet vanaf de oude datum
 * }} Recurrence
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(T\d{2}:\d{2}(?::\d{2})?)?$/;

export function isValidDate(s) {
  if (typeof s !== 'string') return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (!(t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d)) return false;
  if (m[4]) {
    const [hh, mm, ss] = m[4].slice(1).split(':').map(Number);
    if (hh > 23 || mm > 59 || (ss ?? 0) > 59) return false;
  }
  return true;
}

export function isValidRecurrence(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return false;
  for (const k of Object.keys(r)) if (!['freq', 'interval', 'byweekday', 'bymonthday', 'nth', 'fromCompletion'].includes(k)) return false;
  if (r.fromCompletion !== undefined && r.fromCompletion !== true) return false;
  if (!['daily', 'weekly', 'monthly', 'yearly'].includes(r.freq)) return false;
  if (r.interval !== undefined && !(Number.isInteger(r.interval) && r.interval >= 1 && r.interval <= 1000)) return false;
  if (r.byweekday !== undefined) {
    if (r.freq !== 'weekly' && !(r.freq === 'monthly' && r.nth !== undefined)) return false;
    if (!Array.isArray(r.byweekday) || r.byweekday.length === 0 || r.byweekday.length > 7) return false;
    if (!r.byweekday.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) return false;
  }
  if (r.nth !== undefined) {
    if (r.freq !== 'monthly' || r.bymonthday !== undefined) return false;
    if (![1, 2, 3, 4, -1].includes(r.nth)) return false;
    if (!Array.isArray(r.byweekday) || r.byweekday.length !== 1) return false; // "de tweede dinsdag": één weekdag
  }
  if (r.bymonthday !== undefined) {
    if (r.freq !== 'monthly' && r.freq !== 'yearly') return false;
    if (!(Number.isInteger(r.bymonthday) && r.bymonthday >= 1 && r.bymonthday <= 31)) return false;
  }
  return true;
}

const daysInMonth = (y, m0) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
const isoWeekday = (d) => d.getUTCDay() || 7;

/**
 * De dag van de maand waarop de `nth`-e weekdag `wd` (ISO, 1 = maandag) valt: nth 1-4 = eerste tot vierde, -1 = de laatste.
 * (Een vijfde bestaat niet altijd, daarom kent het model alleen 1-4 en "laatste".)
 */
export function nthWeekdayOfMonth(y, m0, wd, nth) {
  if (nth > 0) {
    const offset = (wd - isoWeekday(new Date(Date.UTC(y, m0, 1))) + 7) % 7;
    return 1 + offset + 7 * (nth - 1);
  }
  const last = daysInMonth(y, m0);
  return last - ((isoWeekday(new Date(Date.UTC(y, m0, last))) - wd + 7) % 7);
}
const fmt = (d) => d.toISOString().slice(0, 10);

/**
 * De eerstvolgende datum na `date` volgens `rec`, of null als die buiten het bereik van het datummodel valt (na 9999-12-31):
 * er komt dan geen volgende keer, en de aanroeper behandelt de taak als niet-terugkerend. Zo ontstaat er nooit een ongeldige datum.
 * @param {string} date
 * @param {Recurrence} rec
 * @returns {string | null}
 */
export function nextOccurrence(date, rec) {
  const next = rawNextOccurrence(date, rec);
  return isValidDate(next) ? next : null;
}

/**
 * De nieuwe datum van een terugkerende taak die wordt afgevinkt. Gewoon: de volgende keer volgens de regel, vanaf de oude datum.
 * Met `fromCompletion` ("elke! 3 dagen"): vanaf de dag dat je afvinkt (`completedOn`, 'YYYY-MM-DD'), met het tijdstip van de taak.
 * Is `completedOn` er niet of ongeldig, dan telt de oude datum (zo blijft het altijd een geldige datum).
 * @param {string} date de huidige datum van de taak
 * @param {Recurrence} rec
 * @param {unknown} [completedOn]
 * @returns {string | null}
 */
export function nextDue(date, rec, completedOn) {
  if (rec.fromCompletion && typeof completedOn === 'string' && completedOn.length === 10 && isValidDate(completedOn)) {
    return nextOccurrence(completedOn + (DATE_RE.exec(date)?.[4] ?? ''), rec);
  }
  return nextOccurrence(date, rec);
}

function rawNextOccurrence(date, rec) {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`ongeldige datum: ${date}`);
  const time = m[4] ?? '';
  const y = Number(m[1]);
  const mo0 = Number(m[2]) - 1;
  const day = Number(m[3]);
  const n = rec.interval ?? 1;
  const cur = new Date(Date.UTC(y, mo0, day));

  switch (rec.freq) {
    case 'daily': {
      cur.setUTCDate(cur.getUTCDate() + n);
      return fmt(cur) + time;
    }
    case 'weekly': {
      if (!rec.byweekday) {
        cur.setUTCDate(cur.getUTCDate() + 7 * n);
        return fmt(cur) + time;
      }
      const days = [...new Set(rec.byweekday)].sort((a, b) => a - b);
      const w = isoWeekday(cur);
      const later = days.find((d) => d > w);
      if (later !== undefined) {
        cur.setUTCDate(cur.getUTCDate() + (later - w));
      } else {
        // naar de maandag van de volgende periode, dan naar de eerste gekozen dag
        cur.setUTCDate(cur.getUTCDate() - (w - 1) + 7 * n + (days[0] - 1));
      }
      return fmt(cur) + time;
    }
    case 'monthly': {
      if (rec.nth !== undefined) {
        // "elke tweede dinsdag van de maand": eerst kijken of die dag nog later in deze maand valt, anders `n` maanden verder
        const wd = rec.byweekday[0];
        const later = nthWeekdayOfMonth(y, mo0, wd, rec.nth);
        if (later > day) return fmt(new Date(Date.UTC(y, mo0, later))) + time;
        const total = y * 12 + mo0 + n;
        const ny = Math.floor(total / 12);
        const nm = total % 12;
        return fmt(new Date(Date.UTC(ny, nm, nthWeekdayOfMonth(ny, nm, wd, rec.nth)))) + time;
      }
      // bymonthday houdt "elke 31e" stabiel: 31 jan -> 28 feb -> 31 mrt (zonder zou het op de 28e blijven hangen)
      const want = rec.bymonthday ?? day;
      const total = y * 12 + mo0 + n;
      const ny = Math.floor(total / 12);
      const nm = total % 12;
      return fmt(new Date(Date.UTC(ny, nm, Math.min(want, daysInMonth(ny, nm))))) + time;
    }
    case 'yearly': {
      const want = rec.bymonthday ?? day;
      const ny = y + n;
      return fmt(new Date(Date.UTC(ny, mo0, Math.min(want, daysInMonth(ny, mo0))))) + time;
    }
    default:
      throw new Error(`onbekende frequentie: ${rec.freq}`);
  }
}
