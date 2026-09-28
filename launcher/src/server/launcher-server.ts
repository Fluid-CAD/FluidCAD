import express from 'express';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import { pruneEngines, setBuiltinEngineLocation } from '../engine/cache.ts';
import { findFreePort } from '../engine/process.ts';
import { EngineScratch } from '../engine/scratch.ts';
import { pinnedVersions } from '../projects/app-state.ts';
import { StartApi } from '../start/api.ts';
import { LauncherAuth } from './auth.ts';
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
 * kernel, so it is up in well under a second.
 */

export type LauncherServerOptions = {
  /** The `fluidcad` package this runs from: its engine, its start page, its version. */
  packageRoot: string;
  /** The first port to try; the first free one at or above it is used. 0 takes any free port. */
  port: number;
  /** Where the engines' output goes, prefixed with their project's name. */
  log?: (line: string, stream: 'stdout' | 'stderr') => void;
};

export type LauncherServer = {
  version: string;
  port: number;
  /** The start screen. */
  url: string;
  /** The start screen with this session's key, which signs a browser in. */
  loginUrl: string;
  /** Every running project's preview, then every engine stopped, then the server closed. */
  close(): Promise<void>;
};

/** Loopback only; see `auth.ts` for everything else that keeps it to its user. */
const HOST = '127.0.0.1';

/** The version of the `fluidcad` package at `packageRoot`. */
export function packageVersion(packageRoot: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(port, HOST, () => {
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
async function listenOnFreePort(server: http.Server, first: number): Promise<number> {
  if (first === 0) {
    await listen(server, 0);
    return (server.address() as AddressInfo).port;
  }
  let candidate = first;
  for (let attempt = 0; attempt < 20; attempt++) {
    candidate = await findFreePort(candidate);
    try {
      await listen(server, candidate);
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
  setBuiltinEngineLocation({ kind: 'package', packageRoot });

  const log = options.log ?? logToConsole;
  const server = http.createServer();
  const port = await listenOnFreePort(server, options.port);
  const auth = new LauncherAuth(port);
  const events = new EventStream();
  const sessions = new SessionRegistry({
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
  app.use('/api', auth.requireSession, express.json({ limit: '64kb' }), createApiRouter({ api, sessions, events }));
  app.use(createStartPageRouter({ root: path.join(packageRoot, 'ui', 'dist-start'), auth }));
  app.use((_request, response) => {
    response.status(404).type('text/plain').send('Not found');
  });

  // Bound first, so the port is known to the cookie's name and the URLs;
  // nobody can know the port to call before this line anyway.
  server.on('request', app);

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

  const url = `http://localhost:${port}/`;
  let closing: Promise<void> | null = null;
  return {
    version,
    port,
    url,
    loginUrl: `${url}?token=${auth.token}`,
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
