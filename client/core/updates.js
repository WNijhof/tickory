// Is er iets bij te werken? Uit het antwoord van GET /api/v1/version (server/updateCheck.ts): de server (alleen voor een beheerder,
// die hem kan bijwerken) en de Android-app (voor iedereen die de app gebruikt). Geen scherm; zie ui/updates.js.

import { compareVersions, isVersion } from '../../shared/version.js';

/**
 * @param {{ version?: string, latest?: { version: string, url: string, apk_url?: string | null } | null, update_available?: boolean } | null} status
 * @param {{ isAdmin?: boolean, appVersion?: string | null }} who
 * @returns {{ kind: 'server' | 'app', version: string, current: string, url: string }[]}
 */
export function updateNotices(status, { isAdmin = false, appVersion = null } = {}) {
  const latest = status?.latest;
  if (!latest || !isVersion(latest.version) || typeof latest.url !== 'string') return [];
  const out = [];
  if (isAdmin && status.update_available && compareVersions(latest.version, status.version) > 0) {
    out.push({ kind: 'server', version: latest.version, current: String(status.version), url: latest.url });
  }
  if (isVersion(appVersion) && compareVersions(latest.version, appVersion) > 0) {
    out.push({ kind: 'app', version: latest.version, current: appVersion, url: latest.apk_url || latest.url });
  }
  return out;
}
