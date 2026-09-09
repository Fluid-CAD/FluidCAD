import type { Request, Response, NextFunction } from 'express';
import type { IncomingMessage } from 'http';

/**
 * The workspace server has no authentication: whoever can reach it can read
 * and rewrite workspace files. Two things keep that to the user's own
 * machine. The server binds the loopback interface (index.ts), so nothing on
 * the LAN can connect. And every request's Host header must name loopback,
 * which closes DNS rebinding: a hostile page can point its own hostname at
 * 127.0.0.1 and become same-origin with the server as far as the browser is
 * concerned, but the browser still sends that hostname as Host, and the
 * server answers 403 instead of serving the workspace.
 *
 * Deliberately exposing the server (`FLUIDCAD_SERVER_HOST=0.0.0.0`) turns the
 * Host check off: a LAN client's Host is the LAN address, and binding beyond
 * loopback is that user's explicit choice.
 */

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** True for a Host header (with or without a port) that names this machine's loopback. */
export function isLoopbackHostHeader(host: string | undefined): boolean {
  if (!host) {
    return false;
  }
  const hostname = stripPort(host.trim().toLowerCase());
  if (LOOPBACK_NAMES.has(hostname) || hostname.endsWith('.localhost')) {
    return true;
  }
  // The whole 127/8 block is loopback; 127.0.0.1 is only its usual spelling.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/** True for a bind address that keeps the server on this machine. */
export function isLoopbackBindAddress(address: string): boolean {
  return isLoopbackHostHeader(address);
}

/** Express middleware: 403 for a Host header that is not loopback (no-op when bound beyond loopback). */
export function createHostGuard(bindAddress: string): (req: Request, res: Response, next: NextFunction) => void {
  const enforce = isLoopbackBindAddress(bindAddress);
  return (req, res, next) => {
    if (enforce && !isLoopbackHostHeader(req.headers.host)) {
      res.status(403).json({ error: `Rejected request for host "${req.headers.host ?? ''}": this server answers only to localhost.` });
      return;
    }
    next();
  };
}

/** The same check for WebSocket upgrades, in the shape `ws`'s verifyClient wants. */
export function createHostGuardVerifyClient(bindAddress: string): (info: { req: IncomingMessage }) => boolean {
  const enforce = isLoopbackBindAddress(bindAddress);
  return ({ req }) => !enforce || isLoopbackHostHeader(req.headers.host);
}

function stripPort(host: string): string {
  // "[::1]:3100" keeps its brackets; "localhost:3100" drops the port.
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const colon = host.indexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
}
