// Een browser zonder venster (Edge of Chrome), bestuurd via het DevTools-protocol. Gedeeld door site-check.ts (de
// controle van de website en de demo) en site-shots.ts (de schermafbeeldingen). Zonder afhankelijkheden.

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';

const CANDIDATES = [
  process.env.SITE_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean) as string[];

export const findBrowser = (): string | null => CANDIDATES.find((p) => existsSync(p)) ?? null;

/**
 * Een netwerkfilter als AdGuard plakt op de computer van de ontwikkelaar eigen code in elke pagina (ook lokale). Dat is
 * geen verkeer van de website zelf: we houden het apart en melden het, net als scripts/e2e.ts doet.
 */
const LOCAL_FILTER = /\blocal\.adguard\.org\b|adguard/i;
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const js = (v: unknown): string => JSON.stringify(v);

export interface Request { url: string; method: string; type: string; status?: number; failed?: string }

export interface Browser {
  send: (method: string, params?: object) => Promise<any>;
  evaluate: <T = any>(expression: string) => Promise<T>;
  /** Wacht tot de voorwaarde (JavaScript in de pagina; mag een belofte opleveren) waar is. */
  waitFor: (expression: string, what: string, timeoutMs?: number) => Promise<void>;
  /** Opent een adres en wacht tot de pagina geladen is. */
  goto: (url: string) => Promise<void>;
  viewport: (width: number, height: number, options?: { scale?: number; mobile?: boolean }) => Promise<void>;
  colorScheme: (scheme: 'light' | 'dark') => Promise<void>;
  screenshot: (options?: { format?: 'png' | 'webp'; quality?: number; clip?: { x: number; y: number; width: number; height: number } }) => Promise<Buffer>;
  /** Fouten en uitzonderingen uit de console van de pagina, sinds de start of de laatste `reset`. */
  errors: string[];
  /** Alle verzoeken die de pagina deed, sinds de start of de laatste `reset`. */
  requests: Request[];
  /** Wat een netwerkfilter op deze computer (AdGuard) aan de pagina toevoegde; hoort niet bij de website en telt niet mee. */
  filtered: string[];
  reset: () => void;
  close: () => Promise<void>;
}

/**
 * Start de browser met een eigen, leeg profiel in `workDir` en verbindt met het eerste tabblad.
 * @param cdpPort de poort voor het DevTools-protocol (kies een eigen poort als er meer testen naast elkaar draaien)
 */
export async function launchBrowser({ workDir, cdpPort, width = 1280, height = 860 }: { workDir: string; cdpPort: number; width?: number; height?: number }): Promise<Browser> {
  const path = findBrowser();
  if (!path) throw new Error('geen browser gevonden (Edge of Chrome); geef het pad in de omgevingsvariabele SITE_BROWSER');
  const profile = `${workDir.replace(/[\\/]+$/, '')}/profile-${cdpPort}`;
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  mkdirSync(profile, { recursive: true });
  const args = [
    '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--hide-scrollbars', '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-features=Translate,msEdgeTranslate,OptimizationHints,MediaRouter', `--window-size=${width},${height}`,
    // In een container (GitHub Actions) werkt de zandbak van de browser niet altijd; het gaat hier om eigen, lokale pagina's.
    ...(process.env.CI ? ['--no-sandbox'] : []),
    // SITE_BROWSER_LANG=en-US bootst een Engelse browser na (zoals op GitHub), om te zien dat de controles niet op de taal van de pc leunen
    ...(process.env.SITE_BROWSER_LANG ? [`--lang=${process.env.SITE_BROWSER_LANG}`] : []),
    'about:blank',
  ];
  const child: ChildProcess = spawn(path, args, { stdio: 'ignore' });

  let ws: WebSocket | null = null;
  let seq = 0;
  const pending = new Map<number, (m: any) => void>();
  const errors: string[] = [];
  const filtered: string[] = [];
  const requests: Request[] = [];
  const byId = new Map<string, Request>();
  const note = (text: string) => (LOCAL_FILTER.test(text) ? filtered : errors).push(text);

  for (let i = 0; i < 150 && !ws; i++) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()) as any[];
      const page = list.find((t) => t.type === 'page');
      if (page) {
        const socket = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { socket.onopen = res; socket.onerror = rej; });
        ws = socket;
      }
    } catch { /* de browser start nog op */ }
    if (!ws) await sleep(100);
  }
  if (!ws) {
    child.kill();
    throw new Error('de browser reageert niet op de debugpoort');
  }
  const socket = ws;
  socket.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)!(m);
      pending.delete(m.id);
    } else if (m.method === 'Network.requestWillBeSent') {
      const r: Request = { url: m.params.request.url, method: m.params.request.method, type: m.params.type ?? '' };
      if (LOCAL_FILTER.test(r.url)) return void filtered.push(`verzoek: ${r.url.slice(0, 80)}`);
      requests.push(r);
      byId.set(m.params.requestId, r);
    } else if (m.method === 'Network.responseReceived') {
      const r = byId.get(m.params.requestId);
      if (r) r.status = m.params.response.status;
    } else if (m.method === 'Network.loadingFailed') {
      const r = byId.get(m.params.requestId);
      if (r && !m.params.canceled) r.failed = m.params.errorText;
    } else if (m.method === 'Runtime.exceptionThrown') {
      note(`uitzondering: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text} (${m.params.exceptionDetails.url ?? ''})`);
    } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      note(`log: ${m.params.entry.text} (${m.params.entry.url ?? ''})`);
    } else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'assert')) {
      note(`console.error: ${m.params.args.map((a: any) => a.value ?? a.description).join(' ')}`);
    }
  };

  const send = (method: string, params: object = {}): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async <T = any>(expression: string): Promise<T> => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`in de pagina: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}\n  bij: ${expression.slice(0, 300)}`);
    return r.result.value as T;
  };
  const waitFor = async (expression: string, what: string, timeoutMs = 10_000): Promise<void> => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      // tijdens het laden van een pagina kan een meting mislukken; dan gewoon opnieuw proberen
      if (await evaluate(`(async () => Boolean(await (${expression})))()`).catch(() => false)) return;
      if (Date.now() > end) {
        const text = await evaluate<string>(`document.body ? document.body.innerText.replace(/\\s+/g, ' ').slice(0, 700) : '(geen pagina)'`).catch(() => '(pagina niet te lezen)');
        throw new Error(`wachten mislukt: ${what}\n  voorwaarde: ${expression}\n  op het scherm: ${text}`);
      }
      await sleep(80);
    }
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  // De app volgt de talen van de browser. De controles zoeken Nederlandse knoppen, dus de taal staat vast op Nederlands, wat de
  // browser zelf ook meldt (een tekst als de taalkeuze van de startpagina zet zijn eigen taal daarna weer).
  const { userAgent } = await send('Browser.getVersion');
  await send('Emulation.setUserAgentOverride', { userAgent, acceptLanguage: 'nl-NL,nl' });

  return {
    send, evaluate, waitFor, errors, requests, filtered,
    reset: () => { errors.length = 0; requests.length = 0; byId.clear(); },
    goto: async (url) => {
      const r = await send('Page.navigate', { url });
      if (r.errorText) throw new Error(`kan ${url} niet openen: ${r.errorText}`);
      await waitFor(`document.readyState === 'complete'`, `pagina geladen: ${url}`, 20_000);
    },
    viewport: (w, h, { scale = 1, mobile = false } = {}) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: scale, mobile }),
    colorScheme: (scheme) => send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }),
    screenshot: async ({ format = 'png', quality, clip } = {}) => {
      const params: Record<string, unknown> = { format, captureBeyondViewport: false };
      if (quality !== undefined) params.quality = quality;
      if (clip) params.clip = { ...clip, scale: 1 };
      return Buffer.from((await send('Page.captureScreenshot', params)).data, 'base64');
    },
    close: async () => {
      try { socket.close(); } catch { /* al dicht */ }
      child.kill();
      await sleep(400);
      rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
    },
  };
}
