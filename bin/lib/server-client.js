import { fork } from 'child_process';
import { createServer } from 'net';
import { readFileSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = resolve(__dirname, '..', '..', 'server', 'dist', 'index.js');

/**
 * Talking to a FluidCAD server from a CLI command, in either of two modes:
 *
 *   attached  — a server is already up for the workspace (`fluidcad serve` or
 *               an editor extension started it). We find its port through
 *               `<workspace>/.fluidcad/instance.json` and POST to it; the
 *               scene it is already serving is the one we act on.
 *   ephemeral — nothing is running. We fork the server on a free port, render
 *               the entry file, use it, and kill it again.
 */

/** A health probe that hasn't answered by now is talking to a dead port. */
const HEALTH_TIMEOUT_MS = 2000;

/** How much of the forked server's output to keep for failure diagnostics. */
const LOG_TAIL_LINES = 15;

// ─── Discovery ──────────────────────────────────────────────────────────

/**
 * The live server for `workspacePath`, or null. A crashed server leaves its
 * instance file behind, so the pid and the health endpoint both get a say.
 */
export async function discoverInstance(workspacePath) {
  let entry;
  try {
    entry = JSON.parse(readFileSync(join(workspacePath, '.fluidcad', 'instance.json'), 'utf8'));
  } catch {
    return null;
  }
  if (entry?.schemaVersion !== 1 || typeof entry.port !== 'number' || typeof entry.pid !== 'number') {
    return null;
  }
  if (!isPidAlive(entry.pid)) {
    return null;
  }
  if (!(await probeHealth(entry.port))) {
    return null;
  }
  return { port: entry.port, pid: entry.pid, version: entry.version };
}

export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return err?.code === 'EPERM';
  }
}

/** True when a FluidCAD server answers `/api/health` on this port. */
export async function probeHealth(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return false;
    }
    const body = await res.json();
    return body?.ok === true;
  } catch {
    return false;
  }
}

/**
 * A port nobody is listening on. `FLUIDCAD_SERVER_PORT=0` is not an option:
 * the server echoes the env value verbatim into its ready URL and instance
 * file rather than reading back what it bound, so the caller must choose.
 */
export function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

/**
 * The first free port at or above `start` — what `serve` uses so a second
 * workspace doesn't die on the first one's 3100. Same scan as the Neovim
 * bridge (`extension/neovim/bridge.cjs`), so both land on the same ports.
 */
export async function findFreePort(start, attempts = 100) {
  const last = Math.min(start + attempts - 1, 65535);
  for (let port = start; port <= last; port++) {
    if (await isPortFree(port)) {
      return port;
    }
  }
  throw new Error(`No free port between ${start} and ${last}.`);
}

/** Probe exactly as the server binds (wildcard host), or we'd miss conflicts. */
function isPortFree(port) {
  return new Promise((resolvePromise, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolvePromise(false);
        return;
      }
      reject(err);
    });
    probe.listen(port, () => {
      probe.close(() => resolvePromise(true));
    });
  });
}

// ─── Ephemeral server ───────────────────────────────────────────────────

/**
 * Fork a server, render `entry` in it, and hand back a handle. Resolves only
 * once the scene is on the server's shelf; throws (having reaped the child)
 * on init failure, compile error, timeout, or an early exit.
 */
export async function startEphemeralServer({ workspacePath, entry, port, deadlineAt }) {
  const child = fork(SERVER_ENTRY, [], {
    env: {
      ...process.env,
      FLUIDCAD_SERVER_PORT: String(port),
      FLUIDCAD_WORKSPACE_PATH: workspacePath,
    },
    // Load-bearing: without it the engine's sourceLocations shift by the SSR
    // transform's line offset, mis-targeting breakpoints and feature edits.
    execArgv: ['--enable-source-maps'],
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });

  // The server is chatty (vite, kernel init). Swallow it, and keep only
  // enough to explain a bring-up failure.
  const output = [];
  const record = (data) => {
    output.push(data.toString());
    if (output.length > 400) {
      output.splice(0, output.length - 400);
    }
  };
  child.stdout.on('data', record);
  child.stderr.on('data', record);

  const logTail = () =>
    output.join('').trimEnd().split('\n').slice(-LOG_TAIL_LINES).join('\n');

  let killed = false;
  const onSignal = () => {
    kill();
    process.exit(130);
  };
  const kill = () => {
    if (killed) {
      return;
    }
    killed = true;
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    // SIGTERM, not SIGKILL: the server deletes its instance file and registry
    // entry on the way out, and a stale one misleads the next discovery.
    try {
      child.kill('SIGTERM');
    } catch {
      // Already gone.
    }
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    await waitForIPC(child, 'ready', remaining(deadlineAt), 'the server to start listening');
    const init = await waitForIPC(child, 'init-complete', remaining(deadlineAt), 'FluidCAD to initialize');
    if (!init.success) {
      throw new Error(`FluidCAD failed to initialize: ${init.error ?? 'unknown error'}`);
    }

    child.send({ type: 'process-file', filePath: entry });
    const rendered = await waitForIPC(
      child,
      'scene-rendered',
      remaining(deadlineAt),
      `${basename(entry)} to render`,
    );
    if (rendered.compileError) {
      throw new Error(formatCompileError(rendered.compileError));
    }
  } catch (err) {
    kill();
    if (err?.code === 'server-exited') {
      const tail = logTail();
      if (tail) {
        err.message += `\n\nLast server output:\n${tail}`;
      }
    }
    throw err;
  }

  return { port, child, kill, logTail };
}

function remaining(deadlineAt) {
  return Math.max(1000, deadlineAt - Date.now());
}

/** Resolve on the next IPC message of `type`; reject on timeout or child death. */
function waitForIPC(child, type, timeoutMs, what) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}. ` +
            'Pass --timeout <sec> to allow more time.',
        ),
      );
    }, timeoutMs);

    const onMessage = (msg) => {
      if (msg?.type === type) {
        cleanup();
        resolvePromise(msg);
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      const how = signal ? `signal ${signal}` : `code ${code}`;
      const err = new Error(`The FluidCAD server exited (${how}) while waiting for ${what}.`);
      err.code = 'server-exited';
      reject(err);
    };
    const onError = (err) => {
      cleanup();
      reject(new Error(`Could not start the FluidCAD server: ${err.message}`));
    };
    function cleanup() {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onError);
    }

    child.on('message', onMessage);
    child.on('exit', onExit);
    child.on('error', onError);
  });
}

/** One line: where the model broke, and why. */
function formatCompileError(compileError) {
  const loc = compileError.sourceLocation;
  const where = loc
    ? `${basename(loc.filePath)}:${loc.line}:${loc.column}`
    : compileError.filePath
      ? basename(compileError.filePath)
      : null;
  const message = compileError.message ?? 'unknown error';
  return where ? `Model failed to compile — ${where}: ${message}` : `Model failed to compile — ${message}`;
}

// ─── HTTP ───────────────────────────────────────────────────────────────

/** POST JSON, read the reply as bytes — export and screenshot both return raw. */
export async function postForBuffer(port, apiPath, body) {
  const res = await fetch(`http://127.0.0.1:${port}${apiPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    ok: res.ok,
    contentType: res.headers.get('content-type') ?? '',
    buffer: Buffer.from(await res.arrayBuffer()),
  };
}

export async function getJson(port, apiPath) {
  const res = await fetch(`http://127.0.0.1:${port}${apiPath}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, body };
}

/** The server's `{ error }` message out of a raw-bytes response. */
export function responseError(result) {
  const text = result.buffer.toString('utf8');
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.error === 'string') {
      return parsed.error;
    }
  } catch {
    // Not JSON — fall through to the raw body.
  }
  return text.slice(0, 300) || `HTTP ${result.status}`;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
