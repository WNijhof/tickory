// HTTP-laag: de API (POST /api/v1/sync, GET /api/v1/events), GET /health en de bestanden van de web-app.
// Zero dependencies. Zet er voor gebruik buiten je eigen netwerk een reverse proxy met TLS voor.
//
// Starten:   TODO_TOKEN=<geheim> node server/main.ts
// Nieuw token genereren:   node server/main.ts --new-token

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSchema } from './schema.ts';
import { currentRev, handleSync, SyncError } from './sync.ts';

const MAX_BODY = 1024 * 1024; // 1 MiB
const DRAIN_LIMIT = 16 * MAX_BODY; // tot hier lezen we een te groot verzoek weg om netjes te kunnen antwoorden
const MIN_TOKEN_LENGTH = 24;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const DEFAULT_CLIENT_DIR = fileURLToPath(new URL('../client/', import.meta.url));
const DEFAULT_SHARED_DIR = fileURLToPath(new URL('../shared/', import.meta.url));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};
// Alleen eigen bronnen: geen inline scripts of stijlen, geen externe verbindingen, niet in een frame te laden.
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "connect-src 'self'",
  "manifest-src 'self'", "worker-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ');
const SAFE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._~-]*$/;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

export interface AppOptions {
  db: DatabaseSync;
  /** Geheim voor de Authorization-header. Minimaal 24 tekens. */
  token: string;
  /** Optioneel: exacte oorsprong die via CORS mag aanroepen (bijvoorbeeld een app-schil op een ander adres). */
  corsOrigin?: string;
  /** Map met de web-app; `null` schakelt het serveren van bestanden uit (alleen API). */
  clientDir?: string | null;
  /** Map met de modules die server en client delen; bereikbaar onder /shared/. */
  sharedDir?: string;
}

export interface App {
  server: Server;
  close: () => Promise<void>;
}

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

/** Vertaalt een URL-pad naar een bestand binnen de toegestane mappen, of null als het pad niet mag. */
export function resolveStatic(pathname: string, clientDir: string, sharedDir: string): { file: string; type: string } | null {
  let p: string;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (p === '/') p = '/index.html';
  if (!p.startsWith('/') || p.includes('\\') || p.includes('\0')) return null;
  const segments = p.split('/').slice(1);
  // geen lege stukken, geen "..", geen verborgen bestanden, geen vreemde tekens (dubbele punt, spaties) en geen Windows-apparaatnamen
  if (segments.length === 0 || !segments.every((s) => SAFE_SEGMENT.test(s) && !s.includes('..') && !WINDOWS_DEVICE.test(s.split('.')[0]))) return null;
  const name = segments[segments.length - 1];
  if (name.endsWith('.test.js')) return null;
  const type = MIME[extname(name).toLowerCase()];
  if (!type) return null;
  const shared = segments[0] === 'shared';
  const root = resolve(shared ? sharedDir : clientDir);
  const rest = shared ? segments.slice(1) : segments;
  if (rest.length === 0) return null;
  const file = resolve(root, ...rest);
  if (!file.startsWith(root + sep)) return null;
  return { file, type };
}

/**
 * Het antwoord voor een bestand van de web-app: status, headers en inhoud. Geeft null als het pad niet bestaat of niet mag.
 * Los van de socket gehouden, zodat tests precies zien wat de server verstuurt (een lokaal netwerkfilter zoals
 * AdGuard kan headers en pagina's onderweg herschrijven).
 */
export async function staticResponse(
  pathname: string, clientDir: string, sharedDir: string, ifNoneMatch: string | null = null,
): Promise<{ status: number; headers: Record<string, string | number>; body?: Buffer } | null> {
  const target = resolveStatic(pathname, clientDir, sharedDir);
  if (!target) return null;
  let content: Buffer;
  try {
    content = await readFile(target.file);
  } catch {
    return null;
  }
  const etag = `"${createHash('sha1').update(content).digest('hex').slice(0, 20)}"`;
  const headers: Record<string, string | number> = {
    'Content-Type': target.type,
    'Cache-Control': 'no-cache', // altijd hercontroleren; met de ETag kost dat bijna niets
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': CSP,
    'X-Frame-Options': 'DENY',
  };
  if (ifNoneMatch === etag) return { status: 304, headers };
  return { status: 200, headers: { ...headers, 'Content-Length': content.length }, body: content };
}

export function createApp(opts: AppOptions): App {
  if (opts.token.length < MIN_TOKEN_LENGTH) throw new Error(`token moet minimaal ${MIN_TOKEN_LENGTH} tekens zijn`);
  const expected = digest(opts.token);
  const listeners = new Set<ServerResponse>();
  const clientDir = opts.clientDir === undefined ? DEFAULT_CLIENT_DIR : opts.clientDir;
  const sharedDir = opts.sharedDir ?? DEFAULT_SHARED_DIR;
  const cors: Record<string, string> = opts.corsOrigin ? { 'Access-Control-Allow-Origin': opts.corsOrigin, Vary: 'Origin' } : {};

  const authorized = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization;
    const given = header?.startsWith('Bearer ') ? header.slice(7) : '';
    return timingSafeEqual(digest(given), expected);
  };

  const send = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void => {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
      ...cors,
    });
    res.end(text);
  };

  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolveBody, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      const tooLarge = () => new SyncError('TOO_LARGE', 'verzoek is te groot');
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size <= MAX_BODY) {
          chunks.push(c);
          return;
        }
        // Te groot: de rest lezen we weg zonder te bewaren en we antwoorden pas aan het eind. Antwoorden terwijl de
        // afzender nog verstuurt, geeft bij de afzender vaak een verbroken verbinding in plaats van een nette 413.
        chunks.length = 0;
        if (size > DRAIN_LIMIT) {
          reject(tooLarge());
          req.destroy(); // zoveel lezen we niet weg
        }
      });
      req.on('end', () => (size > MAX_BODY ? reject(tooLarge()) : resolveBody(Buffer.concat(chunks).toString('utf8'))));
      req.on('error', reject);
    });

  const broadcast = (clientId: string | null, rev: number): void => {
    const msg = `event: sync_needed\ndata: ${JSON.stringify({ client_id: clientId, rev })}\n\n`;
    for (const l of listeners) l.write(msg);
  };

  const serveStatic = async (req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error_code: 'METHOD_NOT_ALLOWED', error: 'gebruik GET' });
    const ifNoneMatch = typeof req.headers['if-none-match'] === 'string' ? req.headers['if-none-match'] : null;
    const out = clientDir === null ? null : await staticResponse(pathname, clientDir, sharedDir, ifNoneMatch);
    if (!out) return send(res, 404, { error_code: 'NOT_FOUND', error: 'onbekend pad' });
    res.writeHead(out.status, out.headers);
    res.end(req.method === 'HEAD' ? undefined : out.body);
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;

      if (req.method === 'OPTIONS' && opts.corsOrigin) {
        res.writeHead(204, {
          ...cors,
          'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Client-Id',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Max-Age': '600',
        });
        res.end();
        return;
      }

      if (path === '/health') {
        if (req.method !== 'GET') return send(res, 405, { error_code: 'METHOD_NOT_ALLOWED', error: 'gebruik GET' });
        return send(res, 200, { ok: true });
      }

      if (!path.startsWith('/api/')) return await serveStatic(req, res, path);

      if (path !== '/api/v1/sync' && path !== '/api/v1/events') return send(res, 404, { error_code: 'NOT_FOUND', error: 'onbekend pad' });
      if (!authorized(req)) return send(res, 401, { error_code: 'UNAUTHORIZED', error: 'ongeldig of ontbrekend token' });

      if (path === '/api/v1/events') {
        if (req.method !== 'GET') return send(res, 405, { error_code: 'METHOD_NOT_ALLOWED', error: 'gebruik GET' });
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
          ...cors,
        });
        res.write(`event: hello\ndata: ${JSON.stringify({ rev: currentRev(opts.db) })}\n\n`);
        listeners.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
        req.on('close', () => {
          clearInterval(ping);
          listeners.delete(res);
        });
        return;
      }

      // POST /api/v1/sync
      if (req.method !== 'POST') return send(res, 405, { error_code: 'METHOD_NOT_ALLOWED', error: 'gebruik POST' });
      const raw = await readBody(req);
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        return send(res, 400, { error_code: 'INVALID_REQUEST', error: 'geen geldige JSON' });
      }
      const clientHeader = req.headers['x-client-id'];
      const clientId = typeof clientHeader === 'string' && CLIENT_ID_RE.test(clientHeader) ? clientHeader : null;
      const before = currentRev(opts.db);
      const result = handleSync(opts.db, payload);
      const after = currentRev(opts.db);
      send(res, 200, result);
      if (after !== before) broadcast(clientId, after);
    } catch (err) {
      if (err instanceof SyncError) {
        // De body is op dit punt volledig weggelezen, dus de verbinding kan gewoon open blijven.
        if (!res.headersSent && !res.destroyed) send(res, err.code === 'TOO_LARGE' ? 413 : 400, { error_code: err.code, error: err.message });
        return;
      }
      console.error('onverwachte fout', err);
      if (!res.headersSent) send(res, 500, { error_code: 'INTERNAL', error: 'interne fout' });
    }
  });

  // een afzender die een body eindeloos laat doorlopen, houdt een verbinding hooguit 30 seconden vast
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

  return {
    server,
    close: () =>
      new Promise((resolveClose) => {
        for (const l of listeners) l.end();
        listeners.clear();
        server.close(() => resolveClose());
        server.closeAllConnections();
      }),
  };
}

// ---------- opstarten ----------

if (import.meta.main) {
  if (process.argv.includes('--new-token')) {
    console.log(randomBytes(32).toString('base64url'));
    process.exit(0);
  }
  const token = process.env.TODO_TOKEN ?? '';
  if (token.length < MIN_TOKEN_LENGTH) {
    console.error(`Zet TODO_TOKEN (minimaal ${MIN_TOKEN_LENGTH} tekens). Genereer er een met: node server/main.ts --new-token`);
    process.exit(1);
  }
  const dbPath = process.env.DB_PATH ?? './data/todo.db';
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  createSchema(db);
  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? 8787);
  const app = createApp({ db, token, corsOrigin: process.env.CORS_ORIGIN || undefined });
  app.server.listen(port, host, () => console.log(`eigen-tool luistert op http://${host}:${port} (database: ${dbPath})`));
  const stop = () => app.close().then(() => { db.close(); process.exit(0); });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
