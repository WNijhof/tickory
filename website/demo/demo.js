// Extra's voor de demo op de website; scripts/build-site.ts zet dit script vóór dat van de app in de demo-pagina.
//
// 1. Niets bewaren. De app onthoudt het laatst bekeken scherm en de gekozen taal in de browser (localStorage, sleutels
//    "tickory.route" en "tickory.lang"). In de demo begint alles elke keer opnieuw, dus halen we dat weg vóór de app start
//    en bij het verlaten van de pagina.
// 2. De taal. Kom je van de Engelse website (…/demo/?lang=en), dan start de app in het Engels; zonder ?lang= volgt de app de
//    taal van de browser, zoals altijd. In Instellingen kun je wisselen.
// 3. De balk bovenaan. De tekst staat al in de pagina (Nederlands); is de taal Engels, dan wordt de balk Engels en wijst de
//    link terug naar de Engelse pagina's. De namen van knoppen komen uit de woordenlijst van de app zelf.
// 4. Geen meldingen (zie onderaan).

import { LANGUAGE_KEY, getLanguage } from './core/i18n.js';
import en from './i18n/en.js';

const params = new URLSearchParams(location.search);
const wanted = params.get('lang');

const forget = () => {
  try {
    localStorage.removeItem('tickory.route');
    localStorage.removeItem(LANGUAGE_KEY);
  } catch { /* opslag niet beschikbaar: dan is er ook niets bewaard */ }
};
forget();
if (wanted === 'nl' || wanted === 'en') {
  try {
    localStorage.setItem(LANGUAGE_KEY, wanted);
  } catch { /* geen opslag: de app volgt dan de taal van de browser */ }
}
addEventListener('pagehide', forget);

// 4. Geen meldingen. Ze komen van een server, en de demo heeft er geen. Zonder PushManager denkt de app dat deze browser geen
//    pushmeldingen kan ontvangen en biedt hij ze niet aan: er gaat geen verzoek naar de server, en de browser vraagt niet om
//    toestemming voor iets dat hier niet werkt. (demo.css zet de uitleg in het scherm Herinneringen en meldingen goed.)
try {
  delete window.PushManager;
} catch { /* niet te verwijderen: dan blijft de app het aanbieden */ }

const bar = document.getElementById('demo-bar');
const language = getLanguage();

if (bar && language === 'en') {
  bar.lang = 'en';
  bar.querySelector('.demo-bar-long').textContent = 'This is a demo: changes are not saved.';
  bar.querySelector('.demo-bar-short').textContent = 'Demo: nothing is saved.';
  bar.querySelector('.demo-tips > summary').textContent = 'Tips';
  bar.querySelector('.demo-tips-body').replaceChildren(
    paragraph('Things to try:'),
    list([
      ['Type in the box at the top: ', code('Tandarts bellen morgen om 9 uur p1'), ' (call the dentist tomorrow at 9, priority 1; dates are typed in Dutch for now). A task with a time gets a reminder (🔔) by itself.'],
      ['Open the task ', strong('Tandarts bellen voor controle'), ' to see and change its reminders.'],
      ['Open ', strong('Huishouden'), ' (the sample household), choose ', strong(en['project.shared']), ' and add the username ', code('kees'), '.'],
      ['Tick off a repeating task (↻): its date moves to the next time.'],
      ['Notifications only come from your own server. In the demo you can see the reminders and the settings (', strong(en['settings.notifications']), '), but nothing goes off.'],
      ['Reloading the page starts over with the sample data.'],
    ]),
  );
  const back = bar.querySelector('.demo-bar-link');
  back.textContent = 'Back to the website';
  back.href = '../en/';
} else if (bar && wanted === 'nl') {
  bar.querySelector('.demo-bar-link').href = '../nl/';
}

// het tips-venster sluiten met Escape of door ernaast te klikken
const tips = bar?.querySelector('.demo-tips');
if (tips) {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && tips.open) {
      tips.open = false;
      tips.querySelector('summary').focus();
    }
  });
  document.addEventListener('click', (e) => {
    if (tips.open && !tips.contains(e.target)) tips.open = false;
  });
}

function el(tag, children) {
  const node = document.createElement(tag);
  node.append(...children);
  return node;
}
function paragraph(text) { return el('p', [text]); }
function code(text) { return el('code', [text]); }
function strong(text) { return el('strong', [text]); }
function list(items) { return el('ul', items.map((parts) => el('li', parts))); }
