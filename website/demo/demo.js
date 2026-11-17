// Extra's voor de demo op de website; scripts/build-site.ts zet dit script vóór dat van de app in de demo-pagina.
//
// 1. Niets bewaren. De app onthoudt het laatst bekeken scherm en de gekozen taal in de browser (localStorage, sleutels
//    "tickory.route" en "tickory.lang"). In de demo begint alles elke keer opnieuw, dus halen we dat weg vóór de app start
//    en bij het verlaten van de pagina.
// 2. De taal. Kom je van de Engelse website (…/demo/?lang=en), dan start de app in het Engels; zonder ?lang= volgt de app de
//    taal van de browser, zoals altijd. In Instellingen kun je wisselen.
// 3. De balk bovenaan. De tekst staat al in de pagina (Engels, de basistaal); is de taal Nederlands, dan wordt de balk Nederlands.
//    De link wijst terug naar de website in die taal. De namen van knoppen komen uit de woordenlijst van de app zelf.
//    De voorbeeldgegevens volgen dezelfde taal (core/demoSeed.js, via core/backend.js).
// 4. Geen meldingen (zie onderaan).
// 5. Elke twee uur vers. Wie de demo langer open laat staan, krijgt na twee uur opnieuw de voorbeeldgegevens (met de datums van
//    dat moment): de pagina laadt opnieuw. Ook als het tabblad lang op de achtergrond stond (dan lopen timers niet op tijd).

import { LANGUAGE_KEY, getLanguage } from './core/i18n.js';
import nl from './i18n/nl.js';

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

const FRESH_MS = 2 * 60 * 60 * 1000;
const startedAt = Date.now();
const freshAgain = () => {
  if (Date.now() - startedAt < FRESH_MS) return;
  forget();
  location.reload();
};
setInterval(freshAgain, 60_000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') freshAgain(); });

// 4. Geen meldingen. Ze komen van een server, en de demo heeft er geen. Zonder PushManager denkt de app dat deze browser geen
//    pushmeldingen kan ontvangen en biedt hij ze niet aan: er gaat geen verzoek naar de server, en de browser vraagt niet om
//    toestemming voor iets dat hier niet werkt. (demo.css zet de uitleg in het scherm Herinneringen en meldingen goed.)
try {
  delete window.PushManager;
} catch { /* niet te verwijderen: dan blijft de app het aanbieden */ }

const bar = document.getElementById('demo-bar');
const language = getLanguage();

if (bar && language === 'nl') {
  bar.lang = 'nl';
  bar.querySelector('.demo-bar-long').textContent = 'Dit is een demo: wijzigingen worden niet bewaard.';
  bar.querySelector('.demo-bar-short').textContent = 'Demo: niets wordt bewaard.';
  bar.querySelector('.demo-tips > summary').textContent = 'Tips';
  bar.querySelector('.demo-tips-body').replaceChildren(
    paragraph('Om te proberen:'),
    list([
      ['Typ in het veld bovenaan: ', code('Tandarts bellen morgen om 9 uur p1'), '. Een taak met een tijd krijgt vanzelf een herinnering (🔔).'],
      ['Open de taak ', strong('Tandarts bellen voor controle'), ' om haar herinneringen te zien en te wijzigen.'],
      ['Open ', strong('Huishouden'), ', kies ', strong(nl['project.shared']), ' en voeg de gebruikersnaam ', code('kees'), ' toe.'],
      ['Vink een taak met een herhaling (↻) af: de datum schuift door naar de volgende keer.'],
      ['Meldingen komen alleen van je eigen server. In de demo zie je de herinneringen en de instellingen (', strong(nl['settings.notifications']), '), maar er gaat niets af.'],
      ['Herlaad je de pagina, dan begint de demo opnieuw met de voorbeeldgegevens; na twee uur gebeurt dat vanzelf.'],
    ]),
  );
  const back = bar.querySelector('.demo-bar-link');
  back.textContent = 'Naar de website';
  back.href = '../nl/';
} else if (bar && language === 'en') {
  bar.querySelector('.demo-bar-link').href = '../en/';
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
