// Extra's voor de demo op de website; scripts/build-site.ts zet dit script vóór dat van de app in de demo-pagina.
//
// 1. Niets bewaren. De app onthoudt het laatst bekeken scherm in de browser (localStorage, sleutel "tickory.route").
//    In de demo begint alles elke keer opnieuw, dus halen we dat weg vóór de app start en bij het verlaten van de pagina.
// 2. De balk bovenaan. De tekst staat al in de pagina (Nederlands); kom je van de Engelse website (…/demo/?lang=en),
//    dan wordt de balk Engels en wijst de link terug naar de Engelse pagina's. De app zelf is voorlopig alleen Nederlands.

const forgetRoute = () => {
  try {
    localStorage.removeItem('tickory.route');
  } catch { /* opslag niet beschikbaar: dan is er ook niets bewaard */ }
};
forgetRoute();
addEventListener('pagehide', forgetRoute);

const bar = document.getElementById('demo-bar');
const lang = new URLSearchParams(location.search).get('lang');

if (bar && lang === 'en') {
  bar.lang = 'en';
  bar.querySelector('.demo-bar-long').textContent = 'This is a demo: changes are not saved. The app itself is in Dutch for now.';
  bar.querySelector('.demo-bar-short').textContent = 'Demo: nothing is saved.';
  bar.querySelector('.demo-tips > summary').textContent = 'Tips';
  bar.querySelector('.demo-tips-body').replaceChildren(
    paragraph('Things to try (the app is in Dutch):'),
    list([
      ['Type in the box at the top: ', code('Tandarts bellen morgen om 9 uur p1'), ' (call the dentist tomorrow at 9, priority 1).'],
      ['Open ', strong('Huishouden'), ', choose ', strong('Gedeeld'), ' (shared) and add the username ', code('kees'), '.'],
      ['Tick off a repeating task (↻): its date moves to the next time.'],
      ['Reloading the page starts over with the sample data.'],
    ]),
  );
  const back = bar.querySelector('.demo-bar-link');
  back.textContent = 'Back to the website';
  back.href = '../en/';
} else if (bar && lang === 'nl') {
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
