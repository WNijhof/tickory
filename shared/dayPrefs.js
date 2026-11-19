// Welke weekdag (ISO: 1 = maandag … 7 = zondag) "Volgende week" en "Weekend" zijn, uit Instellingen › Algemeen (shared/general.js).
// Eén plek voor de datumkiezer en de lezer van Engelse datums; wie er niets over zegt, krijgt maandag en zaterdag.

let nextWeekDay = 1;
let weekendDay = 6;

/** Stel de dagen in; een ongeldige waarde wordt genegeerd. */
export function setDayPrefs({ nextWeek, weekend }) {
  if (Number.isInteger(nextWeek) && nextWeek >= 1 && nextWeek <= 7) nextWeekDay = nextWeek;
  if (Number.isInteger(weekend) && weekend >= 1 && weekend <= 7) weekendDay = weekend;
}

export const getDayPrefs = () => ({ nextWeek: nextWeekDay, weekend: weekendDay });
