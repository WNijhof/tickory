// Versies als "1.2.3" (een "v" ervoor mag) vergelijken, voor de server (server/updateCheck.ts) en de apps (client/core/updates.js).
// Gedeeld door server en client.

const VERSION = /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;

/** Is dit een versie als "1.2.3" of "v1.2.3"? */
export const isVersion = (v) => typeof v === 'string' && VERSION.test(v.trim());

/** Negatief als `a` ouder is dan `b`, 0 als gelijk, positief als nieuwer. Onleesbaar telt als 0.0.0. */
export function compareVersions(a, b) {
  const parts = (v) => (VERSION.exec(String(v ?? '').trim())?.slice(1).map(Number) ?? [0, 0, 0]);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}
