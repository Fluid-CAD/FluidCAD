import { fork, type ChildProcess } from 'child_process';
import net from 'net';
import path from 'path';
import type { ResolvedEngine } from './resolver';

/**
 * Starting an engine.
 *
 * The engine is always a **child process**, never the Electron main process
 * (Invariant 4): it runs OCC wasm, which can abort the whole process hard, and
 * a live Vite server. Today the VS Code extension survives a server crash for
 * exactly this reason, and the shell keeps that property — the window (and
 * Monaco's unsaved buffers) outlives its engine.
 *
 * `ELECTRON_RUN_AS_NODE=1` plus `execPath: process.execPath` is what lets the
 * app run the engine with no system Node installed: the app binary *is* the
 * Node runtime.
 */

const STARTUP_TIMEOUT_MS = 30_000;
const FIRST_PORT = 3100;

export type EngineEvents = {
  /**
   * The child, the moment it is forked — before it is ready. A window that
   * closes or an app that quits during the (long) kernel bring-up needs a
   * handle to stop it; waiting for `startEngine` to resolve leaves an orphan.
   */
  onSpawn?: (child: ChildProcess) => void;
  onLog?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** Every IPC message from the engine, after the startup handshake. */
  onMessage?: (message: any) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
};

export type StartedEngine = {
  child: ChildProcess;
  port: number;
  url: string;
  engine: ResolvedEngine;
};

export async function findFreePort(start = FIRST_PORT, attempts = 200): Promise<number> {
  for (let port = start; port < start + attempts; port += 1) {
    if (await isPortFree(port)) {
      return port;
    }
  }
  throw new Error(`No free port found between ${start} and ${start + attempts}.`);
}

/**
 * Probed on the wildcard address, the way the engine itself listens. A probe
 * on `127.0.0.1` alone passes on macOS while another engine holds `[::]:port`
 * (BSD lets a specific address bind next to a wildcard with SO_REUSEADDR), and
 * the second engine then dies with EADDRINUSE.
 */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port);
  });
}

/**
 * Fork the engine and wait for it to come up. Resolves once `init-complete`
 * says the workspace loaded; rejects with the engine's own error message if it
 * didn't, which is how a lib-identity mismatch or a broken `init.js` reaches
 * the user as a sentence instead of a blank window.
 */
export async function startEngine(
  engine: ResolvedEngine,
  workspacePath: string,
  events: EngineEvents = {},
  options: { preferredPort?: number } = {},
): Promise<StartedEngine> {
  // Restarting a crashed engine reuses its port on purpose: the page is still
  // loaded from that origin and reconnects its socket on a 1s timer, so the
  // window recovers without a reload — and Monaco's unsaved buffers survive.
  const port =
    options.preferredPort && (await isPortFree(options.preferredPort))
      ? options.preferredPort
      : await findFreePort();

  const child = fork(engine.serverEntry, [], {
    // Anchor cwd so Windows can resolve the child across drives; the server
    // reads its configuration from env, not cwd.
    cwd: path.dirname(engine.serverEntry),
    execPath: process.execPath,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      FLUIDCAD_SERVER_PORT: String(port),
      FLUIDCAD_WORKSPACE_PATH: workspacePath,
    },
    // Load-bearing: without it the source locations the engine reports for
    // compile errors are off by the transform's line offset.
    execArgv: ['--enable-source-maps'],
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });

  events.onSpawn?.(child);
  child.stdout?.on('data', (data) => events.onLog?.(String(data).trimEnd(), 'stdout'));
  child.stderr?.on('data', (data) => events.onLog?.(String(data).trimEnd(), 'stderr'));
  child.on('exit', (code, signal) => events.onExit?.(code, signal));

  const url = await new Promise<string>((resolve, reject) => {
    let readyUrl: string | null = null;
    const timeout = setTimeout(() => {
      cleanup();
      child.kill();
      reject(new Error(`The FluidCAD engine did not start within ${STARTUP_TIMEOUT_MS / 1000}s.`));
    }, STARTUP_TIMEOUT_MS);

    const onMessage = (message: any) => {
      if (message?.type === 'ready') {
        readyUrl = typeof message.url === 'string' ? message.url : `http://127.0.0.1:${port}`;
      } else if (message?.type === 'init-complete') {
        cleanup();
        if (message.success) {
          resolve(readyUrl ?? `http://127.0.0.1:${port}`);
        } else {
          // The process is up and listening but will never serve a scene —
          // reap it, or every failed open leaves an engine on a port.
          stopEngine(child);
          reject(new Error(message.error || 'The FluidCAD engine failed to initialize.'));
        }
      }
    };
    const onError = (err: Error) => {
      cleanup();
      stopEngine(child);
      reject(err);
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`The FluidCAD engine exited with code ${code} before it was ready.`));
    };
    function cleanup() {
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
    }

    child.on('message', onMessage);
    child.on('error', onError);
    child.on('exit', onExit);
  });

  // Only now hand messages to the caller: the handshake above is the shell's
  // business, everything after it is the window's.
  if (events.onMessage) {
    child.on('message', events.onMessage);
  }

  return { child, port, url, engine };
}

/** SIGTERM, then SIGKILL if it hasn't gone. The engine cleans up its own registry entry. */
export function stopEngine(child: ChildProcess, graceMs = 3_000): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill('SIGTERM');
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }, graceMs);
  timer.unref?.();
}
