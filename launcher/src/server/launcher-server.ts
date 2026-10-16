import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { pruneEngines, setBuiltinEngineLocation } from '../engine/cache.ts';
import { findFreePort } from '../engine/process.ts';
import { EngineScratch } from '../engine/scratch.ts';
import { pinnedVersions } from '../projects/app-state.ts';
import { ProjectsRoot } from '../projects/projects-root.ts';
import { StartApi } from '../start/api.ts';
import { LauncherAuth, hostnameOf, isLoopbackBindAddress } from './auth.ts';
import { createEngineProxy } from './engine-proxy.ts';
import { EventStream } from './events.ts';
import type { LauncherHealth } from './instance.ts';
import { createApiRouter } from './routes.ts';
import { SessionRegistry } from './session-registry.ts';
import { createStartPageRouter, thumbnailUrl } from './start-page.ts';

/**
 * The start server `npx fluidcad` runs: the desktop app's start screen, in a
 * browser. It is a launcher like the desktop app — the same start page, the
 * same recents, previews, feed and engine cache under `~/.fluidcad`, the same
 * engine resolution for every project — reached over HTTP instead of IPC, and
 * opening each project in a tab of its own instead of a window.
 *
 * Its own engine is the package it runs from: that is what an unpinned
 * project opens with, what a new project is set up with, and what the start
 * screen calls "latest". A project pinned to another version runs that one,
 * downloaded like the desktop app downloads it.
 *
 * No engine runs here: each project's engine is a child process, as in the
 * desktop app (Invariant 4), and this server imports neither Vite nor the
 * kernel, so it is up in well under a second. Each engine binds loopback, and
 * its tab reaches it through this server's proxy (`engine-proxy.ts`), which
 * is what lets a browser on another machine use it when this server is bound
 * for one (`host`).
 */

export type LauncherServerOptions = {
  /** The `fluidcad` package this runs from: its engine, its start page, its version. */
  packageRoot: string;
  /** The first port to try; the first free one at or above it is used. 0 takes any free port. */
  port: number;
  /**
   * The address to bind. Loopback by default; `0.0.0.0` (or a machine's own
   * address) lets other machines reach the start screen and, through the
   * proxy, every project it opens.
   */
  host?: string;
  /**
   * The origin browsers reach this server at when a reverse proxy sits in
   * front (`https://cad.example.com`): what the printed link uses, what counts
   * as the page's own origin, and, when it is https, what makes the session
   * cookie `Secure`.
   */
  publicUrl?: string;
  /**
   * No key and no cookie (`--no-auth`): anyone who reaches the server can use
   * it. Bound beyond loopback, it needs `allowedHosts` (or `publicUrl`), so
   * that the Host check keeps DNS rebinding out in the cookie's place.
   */
  noAuth?: boolean;
  /**
   * The host names browsers reach this server by (`--allowed-host`), such as
   * `cad-server` or `192.0.2.20`: any other Host is refused. Loopback is
   * always answered, and `publicUrl`'s host is added to the list.
   */
  allowedHosts?: string[];
  /** Where the engines' output goes, prefixed with their project's name. */
  log?: (line: string, stream: 'stdout' | 'stderr') => void;
  /**
   * Keep every project in this folder: the start screen lists its projects,
   * New Project asks for a name only, and nothing outside it can be opened.
   */
  projectsRoot?: string;
};

export type LauncherServer = {
  version: string;
  port: number;
  /** The address bound. */
  host: string;
  /** Reachable from other machines: bound beyond loopback. */
  exposed: boolean;
  /** The start screen. */
  url: string;
  /** The start screen with this session's key, which signs a browser in; the start screen itself without auth. */
  loginUrl: string;
  /** Started with `noAuth`: no key, anyone who reaches it can use it. */
  noAuth: boolean;
  /** The folder every project lives in, resolved, or null. */
  projectsRoot: string | null;
  /** Every running project's preview, then every engine stopped, then the server closed. */
  close(): Promise<void>;
};

/** Loopback only, unless `host` says otherwise; see `auth.ts` for everything else that keeps it to its user. */
const DEFAULT_HOST = '127.0.0.1';

/** The version of the `fluidcad` package at `packageRoot`. */
export function packageVersion(packageRoot: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * The origin of `publicUrl`, checked: an http(s) URL with no path of its own,
 * since the start server lives at the root of whatever name reaches it.
 */
export function publicOriginOf(publicUrl: string): string {
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    throw new Error(`The public URL "${publicUrl}" is not a URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`The public URL "${publicUrl}" has to start with http:// or https://.`);
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new Error(`The public URL "${publicUrl}" has to be an origin only, such as https://cad.example.com, with no path.`);
  }
  return url.origin;
}

/**
 * The id a project's page goes by, `/p/<id>/`. In a projects folder the
 * project's name is unique and reads well in the address bar; anywhere else
 * two folders may share a name, so a hash of the path tells them apart.
 */
export function projectIdFor(workspacePath: string, projectsRoot: ProjectsRoot | null): string {
  const name = path.basename(workspacePath);
  if (projectsRoot) {
    return name;
  }
  return `${name}-${crypto.createHash('sha256').update(workspacePath).digest('hex').slice(0, 8)}`;
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

/**
 * Bind `server` to the first free port at or above `first` (any free port for
 * 0) and say which. The probe is the engines' own (`findFreePort`, which also
 * minds a process on the wildcard address), and a port taken between the
 * probe and the bind moves on to the next.
 */
async function listenOnFreePort(server: http.Server, first: number, host: string): Promise<number> {
  if (first === 0) {
    await listen(server, 0, host);
    return (server.address() as AddressInfo).port;
  }
  let candidate = first;
  for (let attempt = 0; attempt < 20; attempt++) {
    candidate = await findFreePort(candidate);
    try {
      await listen(server, candidate, host);
      return candidate;
    } catch (err: any) {
      if (err?.code !== 'EADDRINUSE') {
        throw err;
      }
      candidate += 1;
    }
  }
  throw new Error(`No free port for the start screen at or above ${first}.`);
}

function logToConsole(line: string, stream: 'stdout' | 'stderr'): void {
  if (stream === 'stderr') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export async function startLauncherServer(options: LauncherServerOptions): Promise<LauncherServer> {
  const packageRoot = path.resolve(options.packageRoot);
  const version = packageVersion(packageRoot);
  // Checked before anything listens: a wrong folder or URL is a sentence in the terminal, not a running server.
  const projectsRoot = options.projectsRoot ? ProjectsRoot.open(options.projectsRoot) : null;
  const host = options.host || DEFAULT_HOST;
  const exposed = !isLoopbackBindAddress(host);
  const publicOrigin = options.publicUrl ? publicOriginOf(options.publicUrl) : null;
  const noAuth = options.noAuth === true;
  const allowedHosts = (options.allowedHosts ?? []).map((name) => name.trim()).filter((name) => name !== '');
  if (publicOrigin && (allowedHosts.length > 0 || noAuth)) {
    allowedHosts.push(new URL(publicOrigin).host);
  }
  if (noAuth && exposed && allowedHosts.length === 0) {
    throw new Error(
      'Without auth, FluidCAD bound beyond loopback has to know the names it is reached by: ' +
        'give --allowed-host <name> (or FLUIDCAD_ALLOWED_HOSTS), or --public-url.',
    );
  }
  setBuiltinEngineLocation({ kind: 'package', packageRoot });

  const log = options.log ?? logToConsole;
  const server = http.createServer();
  const port = await listenOnFreePort(server, options.port, host);
  const auth = new LauncherAuth(port, {
    exposed,
    publicOrigin,
    secureCookie: publicOrigin?.startsWith('https:') === true,
    noAuth,
    allowedHosts,
  });
  const events = new EventStream();
  const sessions = new SessionRegistry({
    idFor: (workspacePath) => projectIdFor(workspacePath, projectsRoot),
    onView: (workspacePath, view) => events.send('session', { path: workspacePath, view }),
    changed: () => events.send('changed'),
    log: (project, line, stream) => log(`[${project.name}] ${line}`, stream),
  });
  const api = new StartApi({
    appVersion: version,
    isOpen: (workspacePath) => sessions.isOpen(workspacePath),
    thumbnailUrl,
    openProjectFor: (workspacePath) => sessions.reopenTarget(workspacePath),
    changed: () => events.send('changed'),
    projectsRoot,
  });
  const proxy = createEngineProxy({
    targetFor: (id) => sessions.engineTarget(id),
    startPageFor: (id) => sessions.startPageFor(id),
    signedIn: (request) => auth.signedIn(request),
    sameOrigin: (request) => auth.sameOrigin(request),
  });

  const app = express();
  app.disable('x-powered-by');
  app.use(auth.hostGuard);
  // Unauthenticated on purpose, and all it says is who is here: how a second
  // `npx fluidcad` tells this server from a stale record (`instance.ts`).
  app.get('/api/launcher/health', (_request, response) => {
    const health: LauncherHealth = { ok: true, app: 'fluidcad-launcher', version, pid: process.pid };
    response.json(health);
  });
  app.use('/api', auth.requireSession, express.json({ limit: '64kb' }), createApiRouter({ api, sessions, events, projectsRoot }));
  // The projects' pages: each request checked here, then forwarded to its engine on loopback.
  app.use(proxy.handler);
  app.use(createStartPageRouter({ root: path.join(packageRoot, 'ui', 'dist-start'), auth }));
  app.use((_request, response) => {
    response.status(404).type('text/plain').send('Not found');
  });

  // Bound first, so the port is known to the cookie's name and the URLs;
  // nobody can know the port to call before this line anyway.
  server.on('request', app);
  // The engines' WebSockets, behind the same checks as their pages. Nothing
  // else on this server upgrades: the event stream is plain HTTP.
  // The upgrade skips express, so the Host check is made here too.
  server.on('upgrade', (request, socket, head) => {
    if (!auth.hostAllowed(request.headers.host)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    proxy.upgrade(request, socket, head);
  });

  // The desktop app's launch-time housekeeping, shared cache and all: engines
  // no known project pins, beyond the newest three, and downloads an earlier
  // run quit in the middle of.
  setImmediate(() => {
    try {
      pruneEngines({ keep: 3, protectedVersions: pinnedVersions() });
      EngineScratch.sweep();
    } catch {
      // Housekeeping; never worth failing a launch over.
    }
  });

  // Bound for other machines, the link names the first allowed host, or else the machine.
  const machine = allowedHosts[0] ? hostnameOf(allowedHosts[0]) : os.hostname();
  const url = publicOrigin ? `${publicOrigin}/` : `http://${exposed ? machine : 'localhost'}:${port}/`;
  let closing: Promise<void> | null = null;
  return {
    version,
    port,
    host,
    exposed,
    url,
    loginUrl: noAuth ? url : `${url}?token=${auth.token}`,
    noAuth,
    projectsRoot: projectsRoot?.path ?? null,
    close: () =>
      (closing ??= (async () => {
        await sessions.shutdown();
        events.close();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      })()),
  };
}
