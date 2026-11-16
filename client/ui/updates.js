// Meldingen over een nieuwere versie (core/updates.js): één keer per versie een melding onderin, en zolang het geldt een regel
// bovenaan Instellingen met uitleg. De server vraagt GitHub (server/updateCheck.ts); de app vraagt alleen de eigen server.

import { t } from '../core/i18n.js';
import { updateNotices } from '../core/updates.js';
import { confirmDialog, h, toast } from './dom.js';

const SEEN_KEY = (kind) => `tickory.updateSeen.${kind}`;
const CHECK_EVERY = 6 * 3_600_000;

/** Een adres buiten de app openen: in de browser, en in de Android-app via de browser van het toestel. */
function openOutside(url) {
  const a = h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
}

/**
 * @param {{ api: object, store: object, bridge: object, demo: boolean, getToken: () => string | null }} deps
 */
export function createUpdates({ api, store, bridge, demo, getToken }) {
  let notices = [];
  let checkedAt = 0;
  let busy = false;

  const text = (n) => (n.kind === 'server'
    ? t('update.serverToast', { version: n.version, current: n.current })
    : t('update.appToast', { version: n.version, current: n.current }));

  async function explain(n) {
    const ok = await confirmDialog({
      title: n.kind === 'server' ? t('update.serverTitle', { version: n.version }) : t('update.appTitle', { version: n.version }),
      text: n.kind === 'server' ? t('update.serverText', { version: n.version, current: n.current }) : t('update.appText', { version: n.version, current: n.current }),
      okText: n.kind === 'server' ? t('update.whatsNew') : t('update.download'),
    });
    if (ok) openOutside(n.url);
  }

  /** Kijken (hooguit eens per zes uur, en pas als je bent aangemeld); een nieuwe versie één keer melden. */
  async function check() {
    if (demo || busy || !store.me || !getToken() || Date.now() - checkedAt < CHECK_EVERY) return;
    busy = true;
    checkedAt = Date.now();
    try {
      const status = await api.version();
      const appVersion = bridge.available ? bridge.status()?.appVersion ?? null : null;
      notices = updateNotices(status, { isAdmin: Boolean(store.me?.is_admin), appVersion });
      for (const n of notices) {
        let seen = null;
        try { seen = localStorage.getItem(SEEN_KEY(n.kind)); } catch { /* geen opslag */ }
        if (seen === n.version) continue;
        try { localStorage.setItem(SEEN_KEY(n.kind), n.version); } catch { /* geen opslag: dan elke start */ }
        toast(text(n), { action: { label: t('update.view'), run: () => explain(n) }, timeout: 20_000 });
      }
    } catch { /* geen verbinding of een oudere server: later opnieuw */ } finally {
      busy = false;
    }
  }

  return {
    check,
    /** Regels voor bovenaan het menu Instellingen. */
    menuItems: () => notices.map((n) => ({
      value: `update:${n.kind}`,
      label: n.kind === 'server' ? t('update.menuServer', { version: n.version }) : t('update.menuApp', { version: n.version }),
    })),
    /** Een keuze uit het menu afhandelen; true als het een van deze was. */
    async handle(choice) {
      const n = notices.find((x) => `update:${x.kind}` === choice);
      if (!n) return false;
      await explain(n);
      return true;
    },
  };
}
