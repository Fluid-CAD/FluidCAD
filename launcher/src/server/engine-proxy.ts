import http from 'http';
import net from 'net';
import type { Duplex } from 'stream';
import type { NextFunction, Request, Response } from 'express';

/**
 * The proxy in front of every engine `npx fluidcad` runs.
 *
 * An engine binds loopback and trusts whatever reaches it: that is its whole
 * security model, and it stays that way. So a browser on another machine
 * never reaches an engine; it reaches this, at `/p/<project>/…` on the start
 * server's own port, and this forwards to the engine on loopback — page,
 * API calls and the WebSocket alike — for a request that carries the start
 * server's session cookie, and, when it changes anything, comes from the
 * start server's own pages.
 *
 * The engine's page works under that prefix because every URL it uses is
 * relative to itself (`ui/vite.config.ts`, `ui/src/ui/icon-url.ts`); the
 * prefix always ends in a slash so that they resolve inside it.
 *
 * Written against Node's own `http` and `net` rather than a proxy package:
 * what this forwards is small and fixed, the header handling is the part
 * worth seeing in full, and the launcher stays as light as it is.
 */

/** Every project page lives under this. */
export const PROJECT_PAGE_PREFIX = '/p/';

/** The engine this forwards a project's traffic to. */
export type EngineTarget = { port: number };

export type EngineProxyOptions = {
  /** The running engine behind `/p/<id>/`, or null when the project is not running. */
  targetFor(id: string): EngineTarget | null;
  /** The start page that opens the project again, for a tab whose engine is gone; null for a project never opened. */
  startPageFor(id: string): string | null;
  /** Whether the request carries the start server's session. */
  signedIn(request: http.IncomingMessage): boolean;
  /** Whether the request came from the start server's own pages (`auth.ts`). */
  sameOrigin(request: http.IncomingMessage): boolean;
};

/** Where a project's page is, on the start server: `/p/<id>/`. */
export function projectPageUrl(id: string): string {
  return `${PROJECT_PAGE_PREFIX}${encodeURIComponent(id)}/`;
}

type ProxyPath = {
  id: string;
  /** The path on the engine, with the query string; null for `/p/<id>` without its slash. */
  path: string | null;
};

/** What `/p/<id>/rest?query` names, or null for any other URL. */
export function parseProjectPath(url: string | undefined): ProxyPath | null {
  if (!url || !url.startsWith(PROJECT_PAGE_PREFIX)) {
    return null;
  }
  const queryAt = url.indexOf('?');
  const pathname = queryAt === -1 ? url : url.slice(0, queryAt);
  const query = queryAt === -1 ? '' : url.slice(queryAt);
  const rest = pathname.slice(PROJECT_PAGE_PREFIX.length);
  const slash = rest.indexOf('/');
  const encoded = slash === -1 ? rest : rest.slice(0, slash);
  if (encoded === '') {
    return null;
  }
  let id: string;
  try {
    id = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  if (slash === -1) {
    return { id, path: null };
  }
  return { id, path: `${rest.slice(slash)}${query}` };
}

/** Headers that describe this hop, not the request; never forwarded. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade']);

/**
 * The request's headers as the engine gets them: its own loopback address as
 * Host (the engine answers only to that), no session cookie (the engine has
 * no use for it, and a secret goes no further than it must), and nothing
 * that describes the connection this came in on.
 */
function forwardedHeaders(request: http.IncomingMessage, port: number, options: { upgrade: boolean }): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (name === 'host' || name === 'cookie' || (HOP_BY_HOP.has(name) && !(options.upgrade && (name === 'connection' || name === 'upgrade')))) {
      continue;
    }
    if (value !== undefined) {
      headers[name] = value;
    }
  }
  headers.host = `127.0.0.1:${port}`;
  return headers;
}

/** Whether the request is a page load, which gets a redirect where a call gets a status. */
function isNavigation(request: http.IncomingMessage): boolean {
  if (request.method !== 'GET') {
    return false;
  }
  const dest = request.headers['sec-fetch-dest'];
  if (dest) {
    return dest === 'document';
  }
  return (request.headers.accept ?? '').includes('text/html');
}

function isChanging(request: http.IncomingMessage): boolean {
  return request.method !== 'GET' && request.method !== 'HEAD';
}

export type EngineProxy = {
  /** Express middleware for everything under `/p/`; other URLs pass through. */
  handler(request: Request, response: Response, next: NextFunction): void;
  /** The server's `upgrade` event: the engine's WebSocket, behind the same checks. */
  upgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): void;
};

export function createEngineProxy(options: EngineProxyOptions): EngineProxy {
  const refuse = (response: Response, status: number, message: string): void => {
    response.status(status).json({ error: message });
  };

  const handler = (request: Request, response: Response, next: NextFunction): void => {
    const parsed = parseProjectPath(request.url);
    if (!parsed) {
      next();
      return;
    }
    if (!options.signedIn(request)) {
      if (isNavigation(request)) {
        // The start page says where the link is.
        response.redirect(302, '/');
      } else {
        refuse(response, 401, 'This FluidCAD session has ended. Run npx fluidcad again to open a new one.');
      }
      return;
    }
    if (parsed.path === null) {
      // The page's relative URLs resolve inside `/p/<id>/` only with the slash.
      const queryAt = request.url.indexOf('?');
      response.redirect(302, `${projectPageUrl(parsed.id)}${queryAt === -1 ? '' : request.url.slice(queryAt)}`);
      return;
    }
    if (isChanging(request) && !options.sameOrigin(request)) {
      refuse(response, 403, 'Only FluidCAD pages may call this.');
      return;
    }
    const target = options.targetFor(parsed.id);
    if (!target) {
      const startPage = options.startPageFor(parsed.id);
      if (isNavigation(request) && startPage) {
        response.redirect(302, startPage);
      } else {
        refuse(response, 503, 'This project is not running. Open it from the start screen.');
      }
      return;
    }
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: target.port,
        method: request.method,
        path: parsed.path,
        headers: forwardedHeaders(request, target.port, { upgrade: false }),
      },
      (engineResponse) => {
        const headers: http.OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(engineResponse.headers)) {
          if (!HOP_BY_HOP.has(name) && value !== undefined) {
            headers[name] = value;
          }
        }
        response.writeHead(engineResponse.statusCode ?? 502, headers);
        engineResponse.pipe(response);
      },
    );
    upstream.on('error', () => {
      if (!response.headersSent) {
        refuse(response, 502, 'The project\'s engine did not answer.');
      } else {
        response.destroy();
      }
    });
    request.pipe(upstream);
  };

  const upgrade = (request: http.IncomingMessage, socket: Duplex, head: Buffer): void => {
    const parsed = parseProjectPath(request.url);
    const reject = (status: number, reason: string): void => {
      socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (!parsed || parsed.path === null) {
      reject(404, 'Not Found');
      return;
    }
    if (!options.signedIn(request) || !options.sameOrigin(request)) {
      reject(401, 'Unauthorized');
      return;
    }
    const target = options.targetFor(parsed.id);
    if (!target) {
      reject(503, 'Service Unavailable');
      return;
    }
    const upstream = net.connect(target.port, '127.0.0.1', () => {
      const lines = [`${request.method ?? 'GET'} ${parsed.path} HTTP/1.1`];
      for (const [name, value] of Object.entries(forwardedHeaders(request, target.port, { upgrade: true }))) {
        for (const each of Array.isArray(value) ? value : [value]) {
          lines.push(`${name}: ${each}`);
        }
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) {
        upstream.write(head);
      }
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
  };

  return { handler, upgrade };
}
