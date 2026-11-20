// De teksten van de desktop-app zelf (menu's, systeemvak, meldingen), in het Nederlands en Engels, zoals de Todoist-app ze heeft.
// De web-app in het venster heeft haar eigen teksten.

const NL = {
  quickAdd: 'Taak toevoegen', show: 'Tickory tonen', settings: 'Instellingen', stayInTray: 'In systeemvak blijven draaien',
  changelog: 'Wat is er nieuw', quit: 'Tickory afsluiten', tooltip: 'Tickory', inbox: 'Inbox', today: 'Vandaag', upcoming: 'Aankomend',
  completed: 'Voltooid', notes: 'Notities', productivity: 'Productiviteit', moreToday: 'Nog {n} voor vandaag…', nothingToday: 'Niets voor vandaag',
  hasDueToday: 'Je hebt taken die vandaag af moeten zijn', noDueToday: 'Je hebt geen taken voor vandaag',
  file: 'Bestand', newWindow: 'Nieuw venster', edit: 'Bewerken', undo: 'Ongedaan maken', redo: 'Opnieuw', cut: 'Knippen', copy: 'Kopiëren', paste: 'Plakken',
  pasteAndMatchStyle: 'Plakken en stijl aanpassen', selectAll: 'Alles selecteren', view: 'Weergave', reload: 'Opnieuw laden', fullScreen: 'Schermvullende weergave',
  resetZoom: 'Werkelijke grootte', zoomIn: 'Inzoomen', zoomOut: 'Uitzoomen', devTools: 'Ontwikkelaarstools', back: 'Terug', forward: 'Verder',
  window: 'Venster', floatOnTop: 'Zwevend op voorgrond', minimize: 'Minimaliseren', help: 'Help', guide: 'Handleiding', checkUpdates: 'Controleren op updates',
  about: 'Over Tickory', complete: 'Voltooien', snooze: 'Uitstellen', reminder: 'Herinnering', changeServer: 'Andere server…',
  updateTitle: 'Update', updateReady: 'Er is een nieuwe versie gedownload. Start Tickory opnieuw om hem te gebruiken.', restart: 'Herstarten', later: 'Later',
  upToDate: 'Je hebt de nieuwste versie ({version}).', updateError: 'Controleren op updates lukte niet.', clearData: 'Applicatiegegevens verwijderen',
  clearDataText: 'Weet je zeker dat je de applicatiegegevens wilt verwijderen? Je wordt afgemeld en de instellingen van deze app gaan terug naar de standaard.',
  setupTitle: 'Welkom bij Tickory', setupText: 'Vul het adres van je eigen Tickory-server in. Daarna log je in zoals in de browser.',
  serverLabel: 'Adres van de server', connect: 'Verbinden', serverError_empty: 'Vul een adres in.', serverError_invalid: 'Dit is geen geldig adres.',
  serverError_http: 'Een server buiten je eigen netwerk moet https gebruiken.', serverError_unreachable: 'Op dit adres is geen Tickory-server te bereiken.',
  shortcuts: 'Sneltoetsen', shortcutHint: 'Bijvoorbeeld Control+Space of Super+Alt+S. Leeg laten zet de sneltoets uit.', startup: 'Opstarten',
  openAtLogin: 'Tickory starten als Windows start', startMinimized: 'Daarbij geminimaliseerd starten (in het systeemvak)', save: 'Bewaren', close: 'Sluiten',
  shortcutInvalid: 'Een sneltoets klopt niet of is al in gebruik door een andere app.',
  cancel: 'Annuleren', clear: 'Verwijderen', completedNote: '"{title}" is afgevinkt', snoozedNote: 'Uitgesteld: "{title}"', failedNote: 'Dat lukte niet: geen verbinding met de server.',
  appearance: 'Weergave', theme: 'Thema', theme_system: 'Zoals het apparaat', theme_light: 'Licht', theme_dark: 'Donker', accent: 'Accentkleur',
  accent_tomato: 'Tomaat', accent_teal: 'Zeegroen', accent_blue: 'Blauw', accent_indigo: 'Indigo', accent_violet: 'Paars', accent_rose: 'Roze',
  accent_orange: 'Oranje', accent_green: 'Groen', accent_graphite: 'Grafiet',
  appearanceHint: 'Werkt meteen, in alle vensters van Tickory en in de titelbalk. Dezelfde keuze als in Tickory onder Instellingen › Weergave.',
};
const EN = {
  quickAdd: 'Add task', show: 'Show Tickory', settings: 'Settings', stayInTray: 'Keep running in the tray',
  changelog: "What's new", quit: 'Quit Tickory', tooltip: 'Tickory', inbox: 'Inbox', today: 'Today', upcoming: 'Upcoming',
  completed: 'Completed', notes: 'Notes', productivity: 'Productivity', moreToday: '{n} more for today…', nothingToday: 'Nothing for today',
  hasDueToday: 'You have tasks due today', noDueToday: 'You have no tasks for today',
  file: 'File', newWindow: 'New window', edit: 'Edit', undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste',
  pasteAndMatchStyle: 'Paste and match style', selectAll: 'Select all', view: 'View', reload: 'Reload', fullScreen: 'Full screen',
  resetZoom: 'Actual size', zoomIn: 'Zoom in', zoomOut: 'Zoom out', devTools: 'Developer tools', back: 'Back', forward: 'Forward',
  window: 'Window', floatOnTop: 'Float on top', minimize: 'Minimize', help: 'Help', guide: 'Guide', checkUpdates: 'Check for updates',
  about: 'About Tickory', complete: 'Complete', snooze: 'Snooze', reminder: 'Reminder', changeServer: 'Other server…',
  updateTitle: 'Update', updateReady: 'A new version has been downloaded. Restart Tickory to use it.', restart: 'Restart', later: 'Later',
  upToDate: 'You have the latest version ({version}).', updateError: 'Checking for updates did not work.', clearData: 'Clear application data',
  clearDataText: 'Are you sure you want to clear the application data? You will be signed out and the settings of this app go back to the default.',
  setupTitle: 'Welcome to Tickory', setupText: 'Enter the address of your own Tickory server. Then you sign in as in the browser.',
  serverLabel: 'Server address', connect: 'Connect', serverError_empty: 'Enter an address.', serverError_invalid: 'This is not a valid address.',
  serverError_http: 'A server outside your own network has to use https.', serverError_unreachable: 'There is no Tickory server at this address.',
  shortcuts: 'Shortcuts', shortcutHint: 'For example Control+Space or Super+Alt+S. Leave it empty to turn the shortcut off.', startup: 'Startup',
  openAtLogin: 'Start Tickory when Windows starts', startMinimized: 'Start minimized (in the tray)', save: 'Save', close: 'Close',
  shortcutInvalid: 'A shortcut is not valid or is already used by another app.',
  cancel: 'Cancel', clear: 'Clear', completedNote: '"{title}" completed', snoozedNote: 'Snoozed: "{title}"', failedNote: 'That did not work: no connection with the server.',
  appearance: 'Appearance', theme: 'Theme', theme_system: 'Same as the device', theme_light: 'Light', theme_dark: 'Dark', accent: 'Accent colour',
  accent_tomato: 'Tomato', accent_teal: 'Teal', accent_blue: 'Blue', accent_indigo: 'Indigo', accent_violet: 'Violet', accent_rose: 'Rose',
  accent_orange: 'Orange', accent_green: 'Green', accent_graphite: 'Graphite',
  appearanceHint: 'Takes effect at once, in all Tickory windows and in the title bar. The same choice as in Tickory under Settings › Appearance.',
};

/** De taal: wat je in de app koos, anders die van Windows (Nederlands bij nl-*, anders Engels). */
export const langOf = (chosen, locale) => chosen ?? (String(locale ?? '').toLowerCase().startsWith('nl') ? 'nl' : 'en');

export function translator(lang) {
  const table = lang === 'nl' ? NL : EN;
  return (key, vars = {}) => String(table[key] ?? EN[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

export const KEYS = Object.freeze(Object.keys(NL));
export const KEYS_EN = Object.freeze(Object.keys(EN));
