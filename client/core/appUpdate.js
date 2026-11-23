// Een nieuwe versie van de app meteen gebruiken, ook in een venster dat dagen openstaat (de desktop-app in het systeemvak,
// de Android-app op de achtergrond, een vastgezet tabblad).
//
// De service worker (sw.js) antwoordt uit de bewaarde kopie en haalt de nieuwe versie op de achtergrond op. Na een update van
// de server draaide een open venster dus de oude app tot je hem zelf herlaadde, en de desktop-app opende dan nog het oude
// instellingenvenster. Nu: bij terugkomen in het venster (en elk uur) kijken of er een nieuwe service worker is; neemt die het
// over (controllerchange), dan herladen zodra je niets aan het doen bent. Je gegevens staan in IndexedDB en gaan niet verloren;
// alleen een half getypte tekst zou weg zijn, daarom niet met een venster open of terwijl je typt.

const RETRY_MS = 30_000;
const CHECK_EVERY_MS = 60 * 60 * 1000;
const CHECK_AT_MOST_MS = 5 * 60 * 1000;

/** Ben je iets aan het doen dat een herlaadbeurt zou onderbreken: een venster open, of typen in een veld? */
export function busy(doc) {
  if (doc.querySelector('dialog[open]')) return true;
  const el = doc.activeElement;
  if (!el || el === doc.body) return false;
  if (el.isContentEditable) return true;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

/**
 * @param {{ sw: ServiceWorkerContainer | undefined, win: Window, doc: Document, reload?: () => void, now?: () => number }} options
 * @returns {() => void} stoppen
 */
export function watchAppUpdate({ sw, win, doc, reload = () => win.location.reload(), now = () => Date.now() }) {
  if (!sw) return () => {};
  // De allereerste service worker neemt een pagina ook over: dat is geen nieuwe versie.
  let controlled = Boolean(sw.controller);
  let pending = false;
  let timer = null;
  let lastCheck = now();

  const tryReload = () => {
    if (!pending) return;
    win.clearTimeout(timer);
    if (busy(doc)) {
      timer = win.setTimeout(tryReload, RETRY_MS);
      return;
    }
    pending = false;
    reload();
  };
  const onChange = () => {
    if (!controlled) {
      controlled = true;
      return;
    }
    pending = true;
    tryReload();
  };
  const check = (force = false) => {
    if (!force && now() - lastCheck < CHECK_AT_MOST_MS) return;
    lastCheck = now();
    Promise.resolve(sw.getRegistration?.()).then((r) => r?.update()).catch(() => { /* offline: later opnieuw */ });
  };
  const onBack = () => {
    if (doc.visibilityState === 'hidden') return;
    check();
    tryReload();
  };

  sw.addEventListener('controllerchange', onChange);
  doc.addEventListener('visibilitychange', onBack);
  win.addEventListener('focus', onBack);
  const interval = win.setInterval(() => check(true), CHECK_EVERY_MS);
  return () => {
    sw.removeEventListener('controllerchange', onChange);
    doc.removeEventListener('visibilitychange', onBack);
    win.removeEventListener('focus', onBack);
    win.clearInterval(interval);
    win.clearTimeout(timer);
  };
}
