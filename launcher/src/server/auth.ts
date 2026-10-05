import crypto from 'crypto';
import type { IncomingMessage } from 'http';
import type { NextFunction, Request, Response } from 'express';

/**
 * Who may use the start server. It lists folders anywhere the user can read,
 * sets projects up, and starts and downloads engines — so, unlike an engine's
 * own server, it does not trust whatever reaches it:
 *
 * - It binds loopback unless told otherwise, and then every request's Host
 *   must name loopback. That closes DNS rebinding: a hostile page that points
 *   its own name at 127.0.0.1 is still sent with that name as its Host.
 * - A per-launch token, in the URL `npx fluidcad` opens and prints, is traded
 *   on the first page load for an HttpOnly, SameSite=Strict cookie, and every
 *   API call needs that cookie. Other users of the machine, who can reach
 *   loopback too, do not have it.
 * - A cookie is not enough on localhost: a page on any other port of the same
 *   host is same-site, and sends it. So an API call must come from the start
 *   page's own origin (`Sec-Fetch-Site`, `Origin`), and one that changes
 *   anything carries a header no other origin can send without a CORS
 *   preflight, which this server never grants.
 *
 * Bound beyond loopback (`--host`), for other machines to reach it, the Host
 * check is off — their Host is whatever address they used — and the cookie
 * is what keeps rebinding out: a page under a hostile name has no cookie for
 * the real one, and gets the sign-in page. Behind HTTPS (`--public-url`), the
 * cookie is `Secure` too, and that URL's origin is an origin of the page's
 * own.
 *
 * The same loopback rule as the engine's (`server/src/host-guard.ts`), kept
 * apart for the reason `engine/project-pin.ts` is: the launcher must not
 * depend on engine code.
 */

/** The header every state-changing API call carries; the page's HTTP host sets it. */
export const LAUNCHER_REQUEST_HEADER = 'x-fluidcad-launcher';

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** True for a Host header (with or without a port) that names this machine's loopback. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) {
    return false;
  }
  let hostname = host.trim().toLowerCase();
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']');
    hostname = end === -1 ? hostname : hostname.slice(0, end + 1);
  } else if (hostname.includes(':') && hostname.indexOf(':') === hostname.lastIndexOf(':')) {
    hostname = hostname.slice(0, hostname.indexOf(':'));
  }
  if (LOOPBACK_NAMES.has(hostname) || hostname.endsWith('.localhost')) {
    return true;
  }
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/** True for a bind address that keeps the server on this machine. */
export function isLoopbackBindAddress(address: string): boolean {
  return LOOPBACK_NAMES.has(address.toLowerCase()) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address);
}

type HeaderSource = Pick<IncomingMessage, 'headers'>;

function header(request: HeaderSource, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Whether a request was made by a page of the start server's own origin. A
 * browser says so in `Sec-Fetch-Site`, and puts `Origin` on anything but a
 * plain GET; a request with neither header did not come from a browser page
 * at all (a tool on this machine, which the cookie still has to vouch for).
 * `publicOrigin` is the origin a reverse proxy in front presents, which the
 * page sees as its own while the server sees the proxy's Host.
 */
export function isSameOrigin(request: HeaderSource, publicOrigin: string | null = null): boolean {
  const site = header(request, 'sec-fetch-site');
  if (site && site !== 'same-origin') {
    return false;
  }
  const origin = header(request, 'origin');
  if (!origin) {
    return true;
  }
  const host = header(request, 'host');
  return origin === `http://${host}` || origin === `https://${host}` || (publicOrigin !== null && origin === publicOrigin);
}

/**
 * Whether a page load may act on the URL it carries (`?project=` opens one).
 * The start page itself opens such tabs (`same-origin`), and a reload or a
 * typed URL is the user's own doing (`none`); a link from any other page,
 * another localhost port included, only gets the start screen.
 */
export function mayActOnPageLoad(request: Pick<Request, 'get'>): boolean {
  const site = request.get('sec-fetch-site');
  return !site || site === 'same-origin' || site === 'none';
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0) {
      cookies.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
    }
  }
  return cookies;
}

const SIGN_IN_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>FluidCAD</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:14px/1.5 system-ui,sans-serif;background:#1e1e1e;color:#ddd}
main{max-width:34rem;padding:2rem}code{background:#333;padding:.1rem .35rem;border-radius:4px}</style></head>
<body><main><h1 style="font-size:18px">Open FluidCAD from its link</h1>
<p>This page needs the link <code>npx fluidcad</code> printed in your terminal, which carries a key for this session.
Run <code>npx fluidcad</code> again to open it in your browser.</p></main></body></html>`;

export type LauncherAuthOptions = {
  /** Bound beyond loopback: other machines reach this, with their own Host. */
  exposed?: boolean;
  /** The origin a reverse proxy presents (`--public-url`), accepted as the page's own. */
  publicOrigin?: string | null;
  /** The page is reached over HTTPS: the cookie is never sent in the clear. */
  secureCookie?: boolean;
};

export class LauncherAuth {
  /** The session's key: in the URL the browser is first opened at, then in the cookie. */
  readonly token = crypto.randomBytes(24).toString('base64url');
  private readonly cookieName: string;
  private readonly exposed: boolean;
  private readonly publicOrigin: string | null;
  private readonly secureCookie: boolean;

  /** `port` names the cookie, so two start servers in one browser do not sign each other out. */
  constructor(port: number, options: LauncherAuthOptions = {}) {
    this.cookieName = `fluidcad-launcher-${port}`;
    this.exposed = options.exposed === true;
    this.publicOrigin = options.publicOrigin ?? null;
    this.secureCookie = options.secureCookie === true;
  }

  /** Every request: loopback Host only (DNS rebinding), unless bound for other machines. */
  readonly hostGuard = (request: Request, response: Response, next: NextFunction): void => {
    if (!this.exposed && !isLoopbackHost(request.headers.host)) {
      response.status(403).type('text/plain').send('FluidCAD answers only to localhost.');
      return;
    }
    next();
  };

  /**
   * The start page: a valid `?token=` becomes the cookie and is taken out of
   * the address bar; a page load with neither gets a page explaining where
   * the link is.
   */
  readonly pageLogin = (request: Request, response: Response, next: NextFunction): void => {
    const offered = request.query.token;
    if (typeof offered === 'string') {
      if (!this.matches(offered)) {
        response.status(401).type('html').set('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'").send(SIGN_IN_PAGE);
        return;
      }
      response.setHeader(
        'set-cookie',
        `${this.cookieName}=${this.token}; HttpOnly; SameSite=Strict; Path=/${this.secureCookie ? '; Secure' : ''}`,
      );
      const url = new URL(request.originalUrl, 'http://launcher');
      url.searchParams.delete('token');
      response.redirect(302, `${url.pathname}${url.search}`);
      return;
    }
    if (!this.signedIn(request)) {
      response.status(401).type('html').set('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'").send(SIGN_IN_PAGE);
      return;
    }
    next();
  };

  /** The API and previews: the cookie, from the start page's own origin; a changing call also carries the header. */
  readonly requireSession = (request: Request, response: Response, next: NextFunction): void => {
    if (!this.signedIn(request)) {
      response.status(401).json({ error: 'This FluidCAD session has ended. Run npx fluidcad again to open a new one.' });
      return;
    }
    if (!this.sameOrigin(request)) {
      response.status(403).json({ error: 'Only the FluidCAD start page may call this.' });
      return;
    }
    const changing = request.method !== 'GET' && request.method !== 'HEAD';
    if (changing && request.get(LAUNCHER_REQUEST_HEADER) !== '1') {
      response.status(403).json({ error: 'Only the FluidCAD start page may call this.' });
      return;
    }
    next();
  };

  /** Whether the request carries this session's cookie. */
  signedIn(request: HeaderSource): boolean {
    const cookie = parseCookies(header(request, 'cookie')).get(this.cookieName);
    return cookie !== undefined && this.matches(cookie);
  }

  /** Whether the request came from a page of this server's own, by either name it goes by. */
  sameOrigin(request: HeaderSource): boolean {
    return isSameOrigin(request, this.publicOrigin);
  }

  private matches(candidate: string): boolean {
    const expected = Buffer.from(this.token);
    const offered = Buffer.from(candidate);
    return offered.length === expected.length && crypto.timingSafeEqual(offered, expected);
  }
}
