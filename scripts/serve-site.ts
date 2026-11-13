// Serveert de gebouwde website (_site/) lokaal onder hetzelfde pad als op GitHub Pages, zodat je ziet of alle links
// en bestanden ook onder dat voorvoegsel kloppen. Zonder afhankelijkheden.
//
// Gebruik: node scripts/build-site.ts && node scripts/serve-site.ts [--port 8798] [--base /tickory/] [--root _site]
// Daarna: http://127.0.0.1:8798/tickory/

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

export interface SiteServer {
  server: Server;
  /** Het adres van de hoofdpagina, bv. http://127.0.0.1:8794/tickory/ */
  url: string;
  /** Elk verzoek dat binnenkwam: methode, pad en de status van het antwoord. */
  log: { method: string; path: string; status: number }[];
  close: () => Promise<void>;
}

/**
 * Start de server. Doet wat GitHub Pages doet: een map levert haar index.html, een map zonder afsluitende streep
 * verwijst door, en een onbekend adres geeft 404.html met status 404. Alles buiten `base` bestaat niet.
 */
export function startSiteServer({ root, base = '/tickory/', port = 8794 }: { root: string; base?: string; port?: number }): Promise<SiteServer> {
  const dir = resolve(root);
  if (!existsSync(join(dir, 'demo', 'index.html'))) throw new Error(`geen gebouwde website in ${dir}; draai eerst: node scripts/build-site.ts`);
  const log: SiteServer['log'] = [];
  const server = createServer((req, res) => {
    const send = (status: number, headers: Record<string, string>, body: Buffer | string = '') => {
      log.push({ method: req.method ?? '', path: req.url ?? '', status });
      res.writeHead(status, { 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', ...headers });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    const notFound = () => {
      const page = join(dir, '404.html');
      send(404, { 'Content-Type': MIME['.html'] }, existsSync(page) ? readFileSync(page) : 'Niet gevonden');
    };
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    } catch {
      return send(400, { 'Content-Type': MIME['.txt'] }, 'Ongeldig adres');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { 'Content-Type': MIME['.txt'], Allow: 'GET, HEAD' }, 'Alleen GET');
    if (base !== '/' && (pathname === '/' || pathname === base.slice(0, -1))) return send(302, { Location: base });
    if (!pathname.startsWith(base) || pathname.includes('\0') || pathname.includes('\\')) return notFound();
    const parts = pathname.slice(base.length).split('/');
    if (parts.some((p) => p === '..' || p.startsWith('.'))) return notFound(); // geen verborgen bestanden, niet buiten de map
    let file = resolve(dir, ...parts);
    if (file !== dir && !file.startsWith(dir + sep)) return notFound();
    if (existsSync(file) && statSync(file).isDirectory()) {
      if (!pathname.endsWith('/')) return send(301, { Location: `${pathname}/` });
      file = join(file, 'index.html');
    }
    if (!existsSync(file) || !statSync(file).isFile()) return notFound();
    const type = MIME[extname(file).toLowerCase()];
    if (!type) return notFound();
    return send(200, { 'Content-Type': type }, readFileSync(file));
  });
  return new Promise((done, fail) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      fail(err.code === 'EADDRINUSE' ? new Error(`poort ${port} is al in gebruik (door een andere test of server); kies een andere poort`) : err);
    });
    server.listen(port, '127.0.0.1', () => {
      done({
        server,
        url: `http://127.0.0.1:${port}${base}`,
        log,
        close: () => new Promise((closed) => { server.close(() => closed()); server.closeAllConnections(); }),
      });
    });
  });
}

if (import.meta.main) {
  const arg = (name: string, fallback: string): string => {
    const i = process.argv.indexOf(name);
    return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
  };
  const root = arg('--root', fileURLToPath(new URL('../_site', import.meta.url)));
  try {
    const site = await startSiteServer({ root, base: arg('--base', process.env.SITE_BASE ?? '/tickory/'), port: Number(arg('--port', '8798')) });
    console.log(`De website staat op ${site.url} (Ctrl+C om te stoppen)`);
  } catch (err) {
    console.error(`Fout: ${(err as Error).message}`);
    process.exit(1);
  }
}
