// HTTP-laag: de API, GET /health en de bestanden van de web-app.
// Zero dependencies. Zet er voor gebruik buiten je eigen netwerk een reverse proxy met TLS voor.
//
// Starten:    TODO_ADMIN_USER=anna TODO_ADMIN_PASSWORD='…' node server/main.ts      (bij de allereerste start)
// Accounts:   node server/main.ts user add|passwd|list|enable|disable …              (zie README)
//
// Eindpunten (alles behalve /health en login vraagt "Authorization: Bearer <sessietoken>"):
//   POST /api/v1/auth/login               {username, password, device_name} -> {token, me}
//   POST /api/v1/auth/logout              trekt de sessie van dit apparaat in
//   GET  /api/v1/auth/me                  -> {me}
//   POST /api/v1/auth/password            {current_password, new_password}
//   GET  /api/v1/auth/sessions            -> {sessions}      POST /api/v1/auth/sessions/revoke {id}
//   POST /api/v1/sync                     de sync (zie sync.ts)
//   GET  /api/v1/events                   server-sent events: "sync_needed" zodra er iets veranderde
//   GET  /api/v1/admin/users              (beheerder)   POST /api/v1/admin/users, /update, /password

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSchema } from './schema.ts';
import { currentRev, handleSync, SyncError } from './sync.ts';
import {
  countUsers, createSession, createUser, findSession, getUserById, getUserByName, hashPassword, listSessions, listUsers, LoginLimiter,
  publicMe, revokeSession, revokeSessions, setPasswordHash, updateUser, validatePassword, verifyAgainstDummy, verifyPassword,
} from './users.ts';
import type { UserRow } from './users.ts';

const MAX_BODY = 1024 * 1024; // 1 MiB
const DRAIN_LIMIT = 16 * MAX_BODY; // tot hier lezen we een te groot verzoek weg om netjes te kunnen antwoorden
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
  /** Optioneel: exacte oorsprong die via CORS mag aanroepen (bijvoorbeeld een app-schil op een ander adres). */
  corsOrigin?: string;
  /** Map met de web-app; `null` schakelt het serveren van bestanden uit (alleen API). */
  clientDir?: string | null;
  /** Map met de modules die server en client delen; bereikbaar onder /shared/. */
  sharedDir?: string;
  /** Alleen aanzetten achter een eigen reverse proxy: dan telt het adres uit X-Forwarded-For (de laatste waarde, van de proxy). */
  trustProxy?: boolean;
  /** Voor tests: eigen beperking van inlogpogingen. */
  limiter?: LoginLimiter;
}

export interface App {
  server: Server;
  close: () => Promise<void>;
}

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

const STATUS_FOR: Record<string, number> = {
  UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, TOO_LARGE: 413, TOO_MANY_ATTEMPTS: 429, DUPLICATE: 409, CONFLICT: 409,
};

interface Caller { user: UserRow; sessionId: string }
interface Stream { res: ServerResponse; userId: string; sessionId: string }

export function createApp(opts: AppOptions): App {
  const db = opts.db;
  const streams = new Set<Stream>();
  const limiter = opts.limiter ?? new LoginLimiter();
  const clientDir = opts.clientDir === undefined ? DEFAULT_CLIENT_DIR : opts.clientDir;
  const sharedDir = opts.sharedDir ?? DEFAULT_SHARED_DIR;
  const cors: Record<string, string> = opts.corsOrigin ? { 'Access-Control-Allow-Origin': opts.corsOrigin, Vary: 'Origin' } : {};

  const authenticate = (req: IncomingMessage): Caller | null => {
    const header = req.headers.authorization;
    const given = header?.startsWith('Bearer ') ? header.slice(7) : '';
    const found = given ? findSession(db, given) : null;
    return found && { user: found.user, sessionId: found.sessionId };
  };

  const clientIp = (req: IncomingMessage): string => {
    if (opts.trustProxy) {
      const fwd = req.headers['x-forwarded-for'];
      const last = (Array.isArray(fwd) ? fwd.join(',') : fwd ?? '').split(',').pop()?.trim();
      if (last) return last;
    }
    return req.socket.remoteAddress ?? 'onbekend';
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

  const readJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const raw = await readBody(req);
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new SyncError('INVALID_REQUEST', 'geen geldige JSON');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new SyncError('INVALID_REQUEST', 'verzoek moet een JSON-object zijn');
    return payload as Record<string, unknown>;
  };

  const broadcast = (clientId: string | null, rev: number): void => {
    const msg = `event: sync_needed\ndata: ${JSON.stringify({ client_id: clientId, rev })}\n\n`;
    for (const s of streams) s.res.write(msg);
  };

  /** Sluit de live-verbindingen van een gebruiker (of één sessie), bijvoorbeeld na uitloggen of blokkeren. */
  const closeStreams = (userId: string, sessionId?: string): void => {
    for (const s of [...streams]) {
      if (s.userId === userId && (!sessionId || s.sessionId === sessionId)) {
        s.res.end();
        streams.delete(s);
      }
    }
  };

  const serveStatic = async (req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error_code: 'METHOD_NOT_ALLOWED', error: 'gebruik GET' });
    const ifNoneMatch = typeof req.headers['if-none-match'] === 'string' ? req.headers['if-none-match'] : null;
    const out = clientDir === null ? null : await staticResponse(pathname, clientDir, sharedDir, ifNoneMatch);
    if (!out) return send(res, 404, { error_code: 'NOT_FOUND', error: 'onbekend pad' });
    res.writeHead(out.status, out.headers);
    res.end(req.method === 'HEAD' ? undefined : out.body);
  };

  // ---------- inloggen en account ----------

  const login = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readJson(req);
    const username = typeof body.username === 'string' ? body.username.slice(0, 200) : '';
    const password = typeof body.password === 'string' ? body.password.slice(0, 1000) : '';
    const device = typeof body.device_name === 'string' ? body.device_name : '';
    const ip = clientIp(req);
    const wait = limiter.retryAfter(username, ip);
    if (wait > 0) {
      return send(res, 429, { error_code: 'TOO_MANY_ATTEMPTS', error: `te veel mislukte pogingen; probeer het over ${Math.ceil(wait / 60)} minuut of langer opnieuw` }, { 'Retry-After': String(wait) });
    }
    const user = username ? getUserByName(db, username) : undefined;
    const valid = user ? await verifyPassword(password, user.password_hash) : (await verifyAgainstDummy(password), false);
    if (!user || !valid || user.is_disabled) {
      limiter.fail(username, ip);
      // Dezelfde melding voor onbekende gebruiker, fout wachtwoord en geblokkeerd account.
      return send(res, 401, { error_code: 'INVALID_CREDENTIALS', error: 'gebruikersnaam of wachtwoord klopt niet' });
    }
    limiter.success(username);
    const { token, id } = createSession(db, user.id, device);
    send(res, 200, { token, session_id: id, me: publicMe(user) });
  };

  const changePassword = async (req: IncomingMessage, res: ServerResponse, caller: Caller): Promise<void> => {
    const body = await readJson(req);
    const current = getUserByName(db, caller.user.username);
    if (!current || typeof body.current_password !== 'string' || !(await verifyPassword(body.current_password, current.password_hash))) {
      return send(res, 403, { error_code: 'FORBIDDEN', error: 'het huidige wachtwoord klopt niet' });
    }
    const next = validatePassword(body.new_password, caller.user.username);
    setPasswordHash(db, caller.user.id, await hashPassword(next), caller.sessionId); // andere apparaten moeten opnieuw inloggen
    closeStreams(caller.user.id); // live-verbindingen van andere apparaten; dit apparaat verbindt vanzelf opnieuw
    send(res, 200, { ok: true });
  };

  // ---------- beheer ----------

  const adminUsers = async (req: IncomingMessage, res: ServerResponse, path: string, caller: Caller): Promise<void> => {
    const view = (u: UserRow) => ({ ...publicMe(u), is_disabled: u.is_disabled, created_at: u.created_at });
    if (path === '/api/v1/admin/users' && req.method === 'GET') return send(res, 200, { users: listUsers(db).map(view) });
    if (req.method !== 'POST') return send(res, 405, { error_code: 'METHOD_NOT_ALLOWED', error: 'gebruik POST' });
    const body = await readJson(req);
    if (path === '/api/v1/admin/users') {
      const password = validatePassword(body.password, typeof body.username === 'string' ? body.username : undefined);
      const user = createUser(db, {
        username: body.username as string, name: (body.name ?? body.username) as string, passwordHash: await hashPassword(password), isAdmin: body.is_admin === true,
      });
      return send(res, 200, { user: view(user) });
    }
    const id = typeof body.id === 'string' ? body.id : '';
    if (!getUserById(db, id)) return send(res, 404, { error_code: 'NOT_FOUND', error: 'gebruiker bestaat niet' });
    if (path === '/api/v1/admin/users/update') {
      if (id === caller.user.id && (body.is_disabled === true || body.is_admin === false)) {
        return send(res, 409, { error_code: 'CONFLICT', error: 'je kunt jezelf niet blokkeren of de beheerdersrechten afnemen' });
      }
      const user = updateUser(db, id, { name: body.name, is_admin: body.is_admin, is_disabled: body.is_disabled });
      if (user.is_disabled) closeStreams(id);
      return send(res, 200, { user: view(user) });
    }
    if (path === '/api/v1/admin/users/password') {
      const target = getUserById(db, id)!;
      setPasswordHash(db, id, await hashPassword(validatePassword(body.new_password, target.username)));
      closeStreams(id);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error_code: 'NOT_FOUND', error: 'onbekend pad' });
  };

  // ---------- routering ----------

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

      if (path === '/api/v1/auth/login') {
        if (req.method !== 'POST') return send(res, 405, { error_code: 'METHOD_NOT_ALLOWED', error: 'gebruik POST' });
        return await login(req, res);
      }

      const known = path === '/api/v1/sync' || path === '/api/v1/events' || path.startsWith('/api/v1/auth/') || path.startsWith('/api/v1/admin/users');
      if (!known) return send(res, 404, { error_code: 'NOT_FOUND', error: 'onbekend pad' });
      const caller = authenticate(req);
      if (!caller) return send(res, 401, { error_code: 'UNAUTHORIZED', error: 'ongeldige of ontbrekende aanmelding' });

      if (path.startsWith('/api/v1/admin/')) {
        if (!caller.user.is_admin) return send(res, 403, { error_code: 'FORBIDDEN', error: 'alleen voor beheerders' });
        return await adminUsers(req, res, path, caller);
      }

      if (path === '/api/v1/auth/me') {
        if (req.method !== 'GET') return send(res, 405, { error_code: 'METHOD_NOT_ALLOWED', error: 'gebruik GET' });
        return send(res, 200, { me: publicMe(caller.user) });
      }
      if (path === '/api/v1/auth/logout') {
        if (req.method !== 'POST') return send(res, 405, { error_code: 'METHOD_NOT_ALLOWED', error: 'gebruik POST' });
        revokeSession(db, caller.user.id, caller.sessionId);
        closeStreams(caller.user.id, caller.sessionId);
        return send(res, 200, { ok: true });
      }
      if (path === '/api/v1/auth/password') {
        if (req.method !== 'POST') return send(res, 405, { error_code: 'METHOD_NOT_ALLOWED', error: 'gebruik POST' });
        return await changePassword(req, res, caller);
      }
      if (path === '/api/v1/auth/sessions') {
        if (req.method !== 'GET') return send(res, 405, { error_code: 'METHOD_NOT_ALLOWED', error: 'gebruik GET' });
        return send(res, 200, { sessions: listSessions(db, caller.user.id).map((s) => ({ ...s, current: s.id === caller.sessionId })) });
      }
      if (path === '/api/v1/auth/sessions/revoke') {
        if (req.method !== 'POST') return send(res, 405, { error_code: 'METHOD_NOT_ALLOWED', error: 'gebruik POST' });
        const body = await readJson(req);
        const sessionId = typeof body.id === 'string' ? body.id : '';
        if (!revokeSession(db, caller.user.id, sessionId)) return send(res, 404, { error_code: 'NOT_FOUND', error: 'deze sessie bestaat niet' });
        closeStreams(caller.user.id, sessionId);
        return send(res, 200, { ok: true });
      }
      if (path.startsWith('/api/v1/auth/')) return send(res, 404, { error_code: 'NOT_FOUND', error: 'onbekend pad' });

      if (path === '/api/v1/events') {
        if (req.method !== 'GET') return send(res, 405, { error_code: 'METHOD_NOT_ALLOWED', error: 'gebruik GET' });
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
          ...cors,
        });
        res.write(`event: hello\ndata: ${JSON.stringify({ rev: currentRev(db) })}\n\n`);
        const stream: Stream = { res, userId: caller.user.id, sessionId: caller.sessionId };
        streams.add(stream);
        const ping = setInterval(() => {
          // een ingetrokken sessie of geblokkeerd account houdt de verbinding niet open
          if (!findSession(db, req.headers.authorization?.slice(7) ?? '')) {
            res.end();
            return;
          }
          res.write(': ping\n\n');
        }, 25_000);
        req.on('close', () => {
          clearInterval(ping);
          streams.delete(stream);
        });
        return;
      }

      // POST /api/v1/sync
      if (req.method !== 'POST') return send(res, 405, { error_code: 'METHOD_NOT_ALLOWED', error: 'gebruik POST' });
      const payload = await readJson(req);
      const clientHeader = req.headers['x-client-id'];
      const clientId = typeof clientHeader === 'string' && CLIENT_ID_RE.test(clientHeader) ? clientHeader : null;
      const before = currentRev(db);
      const result = handleSync(db, payload, caller.user.id);
      const after = currentRev(db);
      send(res, 200, result);
      if (after !== before) broadcast(clientId, after);
    } catch (err) {
      if (err instanceof SyncError) {
        // De body is op dit punt volledig weggelezen, dus de verbinding kan gewoon open blijven.
        if (!res.headersSent && !res.destroyed) send(res, STATUS_FOR[err.code] ?? 400, { error_code: err.code, error: err.message });
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
        for (const s of streams) s.res.end();
        streams.clear();
        server.close(() => resolveClose());
        server.closeAllConnections();
      }),
  };
}

// ---------- opstarten en beheeropdrachten ----------

/** Vraagt om een wachtwoord zonder het te tonen. Alleen voor een interactieve terminal. */
function askHidden(prompt: string): Promise<string> {
  return new Promise((done, abort) => {
    if (!process.stdin.isTTY) return abort(new Error('geen terminal; geef het wachtwoord mee in de omgevingsvariabele TODO_PASSWORD'));
    process.stdout.write(prompt);
    let text = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off('data', onData);
          process.stdout.write('\n');
          return done(text);
        }
        if (ch === '\u0003') { process.stdout.write('\n'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') text = [...text].slice(0, -1).join('');
        else text += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function passwordFor(username: string): Promise<string> {
  const given = process.env.TODO_PASSWORD;
  if (given) return validatePassword(given, username);
  const a = await askHidden(`Wachtwoord voor ${username}: `);
  const b = await askHidden('Nog een keer: ');
  if (a !== b) throw new Error('de wachtwoorden zijn niet gelijk');
  return validatePassword(a, username);
}

function openDatabase(): DatabaseSync {
  const dbPath = process.env.DB_PATH ?? './data/todo.db';
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  createSchema(db);
  return db;
}

async function userCommand(args: string[]): Promise<void> {
  const [action, username, ...rest] = args;
  const db = openDatabase();
  const flag = (name: string): string | undefined => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const target = () => {
    const u = username ? getUserByName(db, username) : undefined;
    if (!u) throw new Error(`gebruiker "${username ?? ''}" bestaat niet`);
    return u;
  };
  switch (action) {
    case 'list':
      for (const u of listUsers(db)) console.log(`${u.username.padEnd(24)} ${u.name.padEnd(28)} ${u.is_admin ? 'beheerder' : 'gebruiker'}${u.is_disabled ? ' (geblokkeerd)' : ''}`);
      break;
    case 'add': {
      if (!username) throw new Error('gebruik: user add <gebruikersnaam> [--name "Volledige naam"] [--admin]');
      const u = createUser(db, { username, name: flag('--name') ?? username, passwordHash: await hashPassword(await passwordFor(username)), isAdmin: rest.includes('--admin') });
      console.log(`Account "${u.username}" aangemaakt${u.is_admin ? ' (beheerder)' : ''}.`);
      break;
    }
    case 'passwd': {
      const u = target();
      setPasswordHash(db, u.id, await hashPassword(await passwordFor(u.username)));
      console.log(`Wachtwoord van "${u.username}" gewijzigd; alle apparaten van deze gebruiker zijn afgemeld.`);
      break;
    }
    case 'disable': case 'enable': {
      const u = target();
      updateUser(db, u.id, { is_disabled: action === 'disable' });
      console.log(`Account "${u.username}" is ${action === 'disable' ? 'geblokkeerd' : 'weer actief'}.`);
      break;
    }
    case 'logout-all': {
      const u = target();
      revokeSessions(db, u.id);
      console.log(`Alle apparaten van "${u.username}" zijn afgemeld.`);
      break;
    }
    default:
      throw new Error('gebruik: user list | add <naam> [--name "…"] [--admin] | passwd <naam> | disable <naam> | enable <naam> | logout-all <naam>');
  }
  db.close();
}

if (import.meta.main) {
  if (process.argv[2] === 'user') {
    userCommand(process.argv.slice(3)).catch((err: Error) => {
      console.error(`Fout: ${err.message}`);
      process.exit(1);
    });
  } else {
    const db = openDatabase();
    if (countUsers(db) === 0) {
      const admin = process.env.TODO_ADMIN_USER;
      const password = process.env.TODO_ADMIN_PASSWORD;
      if (admin && password) {
        try {
          const u = createUser(db, { username: admin, name: process.env.TODO_ADMIN_NAME || admin, passwordHash: await hashPassword(validatePassword(password, admin)), isAdmin: true });
          console.log(`Eerste account "${u.username}" (beheerder) aangemaakt. Je kunt TODO_ADMIN_PASSWORD nu uit je instellingen halen.`);
        } catch (err) {
          console.error(`Het eerste account kon niet worden aangemaakt: ${(err as Error).message}`);
          process.exit(1);
        }
      } else {
        console.warn('Er zijn nog geen accounts. Zet TODO_ADMIN_USER en TODO_ADMIN_PASSWORD (minimaal 10 tekens) en start opnieuw, of gebruik: node server/main.ts user add <naam> --admin');
      }
    }
    const host = process.env.HOST ?? '127.0.0.1';
    const port = Number(process.env.PORT ?? 8787);
    const app = createApp({ db, corsOrigin: process.env.CORS_ORIGIN || undefined, trustProxy: process.env.TRUST_PROXY === '1' });
    app.server.listen(port, host, () => console.log(`Tickory luistert op http://${host}:${port} (database: ${process.env.DB_PATH ?? './data/todo.db'})`));
    const stop = () => app.close().then(() => { db.close(); process.exit(0); });
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }
}
