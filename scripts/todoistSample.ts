// Een verzonnen back-up van Todoist (een zip met per project een CSV, Nederlandse en Engelse taken) voor de tests van het importeren:
// client/core/todoistImport.test.js en scripts/e2e-import.ts. Alle namen en teksten zijn verzonnen; geen echte gegevens.

import { makeZip } from './zipFixture.ts';

export const HEADER = 'TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE';
export const HEADER_NEW = `${HEADER},DURATION,DURATION_UNIT,DEADLINE,DEADLINE_LANG`;
const csv = (...lines: string[]) => `${lines.join('\r\n')}\r\n`;

/** Een back-up zoals Todoist die maakt: een zip met per project een CSV (verzonnen inhoud, Nederlands en Engels). */
export async function sampleBackup(): Promise<Uint8Array> {
  const inbox = `\uFEFF${csv(HEADER_NEW,
    'task,Call the dentist @phone,,1,1,Sam (40000001),,tomorrow at 9am,en,Europe/Amsterdam,15,minute,,',
    'task,Water the plants,,4,1,Sam (40000001),,every monday,en,Europe/Amsterdam,,None,,',
    'task,Pay rent @money,"Transfer before the 1st, ""urgent""",2,1,Sam (40000001),,every month on the 1st,en,Europe/Amsterdam,,None,,',
    'task,File taxes,,3,1,Sam (40000001),,every 3rd workday,en,Europe/Amsterdam,,None,Jan 12,en',
    'note,"See the photo [[file {""file_name"":""receipt.jpg"",""file_url"":""https://example.invalid/r.jpg""}]]",,,,Sam (40000001),,,,,,,,',
    'task,Book flights,,4,1,Sam (40000001),Kim (40000002),Jan 12,en,Europe/Amsterdam,2,day,,')}`;
  const huis = csv(HEADER_NEW,
    'meta,view_style=board,,,,,,,,,,,,',
    'task,Oud papier buiten zetten,,4,1,Sam (40000001),,elke tweede dinsdag,nl,Europe/Amsterdam,,None,,',
    'section,Keuken,,,,,,,,,,,,',
    'task,Koelkast schoonmaken @schoonmaak,,2,1,Sam (40000001),,zaterdag,nl,Europe/Amsterdam,45,minute,,',
    'task,Planken uitnemen,,4,2,Sam (40000001),,,,Europe/Amsterdam,,None,,',
    'task,Lampje vervangen,,4,3,Sam (40000001),,,,Europe/Amsterdam,,None,,',
    'note,Het lampje is een E14,,,,Kim (40000002),,,,,,,,',
    'section,Tuin,,,,,,,,,,,,',
    'task,Heg snoeien @schoonmaak,,4,1,Sam (40000001),,,,Europe/Amsterdam,,None,2026-12-24,nl');
  const werk = csv(HEADER, 'task,Weekplanning maken,,1,1,Sam (40000001),,every friday at 16:00,en,Europe/Amsterdam');
  const klanten = csv(HEADER, 'task,Offerte sturen naar Bakkerij De Korenaar,,2,1,Sam (40000001),,2026-11-20,en,Europe/Amsterdam');
  const markt = csv(HEADER, 'task,Kaas en appels,,4,1,,,,,');
  return makeZip([
    { name: 'Inbox [40000101].csv', data: inbox },
    { name: 'Huishouden [40000102].csv', data: huis, descriptor: true },
    { name: 'Werk [40000103].csv', data: werk, method: 0 },
    { name: 'Werk - Klanten [40000104].csv', data: klanten },
    { name: 'Boodschappen - Markt [40000105].csv', data: markt },
    { name: 'leesmij.txt', data: 'geen project' },
    { name: '../buiten.csv', data: markt },
  ]);
}
