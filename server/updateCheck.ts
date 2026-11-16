// Is er een nieuwere Tickory? De server kijkt twee keer per dag bij GitHub wat de nieuwste release is (een GET op de openbare API,
// zonder iets over deze server of zijn gebruikers mee te sturen; alleen een vaste User-Agent). De apps vragen het aan de eigen server
// (GET /api/v1/version), zodat telefoons en browsers zelf nooit met GitHub praten.
//
//   UPDATE_CHECK=0   uit (geen enkele verbinding met GitHub)
//
// De beheerder ziet in de app dat de server bijgewerkt kan worden; in de Android-app ziet iedereen dat er een nieuwere app is, met
// een link naar de release (de APK). Alleen adressen op github.com/WNijhof/tickory worden doorgegeven.

import { readFileSync } from 'node:fs';
import { compareVersions } from '../shared/version.js';

export { compareVersions };

export const RELEASES_API = 'https://api.github.com/repos/WNijhof/tickory/releases/latest';
const OUR_RELEASES = /^https:\/\/github\.com\/WNijhof\/tickory\/releases\/[\w./%-]+$/;
const VERSION = /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;

export interface Release { version: string; url: string; published_at: string | null; apk_url: string | null }
export interface UpdateStatus {
  /** De versie van deze server. */
  version: string;
  /** De nieuwste release op GitHub, of null (nog niet gekeken, uit, of niet gelukt). */
  latest: Release | null;
  /** Is `latest` nieuwer dan deze server? */
  update_available: boolean;
  checked_at: string | null;
  enabled: boolean;
}

/** De versie van deze server, uit package.json (dat zit ook in het Docker-image). */
export function serverVersion(): string {
  try {
    const v = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
    return typeof v === 'string' && VERSION.test(v) ? v.replace(/^v/, '') : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Het antwoord van GitHub (releases/latest) als release; null als het er niet uitziet als een release van ons. */
export function parseRelease(json: unknown): Release | null {
  if (!json || typeof json !== 'object') return null;
  const r = json as Record<string, unknown>;
  if (r.draft === true || r.prerelease === true) return null;
  const tag = typeof r.tag_name === 'string' ? r.tag_name.trim() : '';
  if (!VERSION.test(tag)) return null;
  const url = typeof r.html_url === 'string' && OUR_RELEASES.test(r.html_url) ? r.html_url : null;
  if (!url) return null;
  const assets = Array.isArray(r.assets) ? r.assets as Record<string, unknown>[] : [];
  const apk = assets.find((a) => typeof a?.name === 'string' && /\.apk$/i.test(a.name) && typeof a.browser_download_url === 'string' && OUR_RELEASES.test(a.browser_download_url));
  const published = typeof r.published_at === 'string' && !Number.isNaN(Date.parse(r.published_at)) ? new Date(r.published_at).toISOString() : null;
  return { version: tag.replace(/^v/, ''), url, published_at: published, apk_url: (apk?.browser_download_url as string | undefined) ?? null };
}

export const updateCheckEnabled = (env: Record<string, string | undefined>): boolean => (env.UPDATE_CHECK ?? '1').trim() !== '0';

/**
 * @param opts.fetch voor tests; standaard de gewone fetch
 * @param opts.url het adres van de API (standaard GitHub; anders alleen voor tests)
 */
export function createUpdateCheck(opts: { current?: string; fetch?: typeof fetch; now?: () => number; log?: (line: string) => void; url?: string } = {}) {
  const current = opts.current ?? serverVersion();
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((line: string) => console.log(line));
  let latest: Release | null = null;
  let checkedAt: string | null = null;
  let announced = '';

  /** Eén keer kijken. Een fout (geen verbinding, GitHub weigert) laat de vorige uitkomst staan. */
  async function check(): Promise<void> {
    try {
      const res = await fetchFn(opts.url ?? RELEASES_API, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Tickory-update-check' },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 404) { latest = null; checkedAt = new Date(now()).toISOString(); return; } // nog geen release
      if (!res.ok) throw new Error(`GitHub antwoordde ${res.status}`);
      const found = parseRelease(await res.json());
      if (!found) throw new Error('het antwoord van GitHub was geen bruikbare release');
      latest = found;
      checkedAt = new Date(now()).toISOString();
      if (compareVersions(found.version, current) > 0 && announced !== found.version) {
        announced = found.version;
        log(`Er is een nieuwere Tickory: ${found.version} (deze server draait ${current}). Zie ${found.url}`);
      }
    } catch (err) {
      console.warn(`kijken of er een nieuwere Tickory is, lukte niet: ${(err as Error).message}`);
    }
  }

  function status(): UpdateStatus {
    return { version: current, latest, update_available: latest !== null && compareVersions(latest.version, current) > 0, checked_at: checkedAt, enabled: true };
  }

  return { check, status };
}

export type UpdateCheck = ReturnType<typeof createUpdateCheck>;
