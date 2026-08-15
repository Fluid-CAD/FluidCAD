import { fork } from 'child_process';
import { existsSync } from 'fs';
import { resolve, dirname, isAbsolute, join } from 'path';
import { fileURLToPath } from 'url';
import open from 'open';
import { createFileWatcher, findFluidFiles, isFluidScriptFile } from '../watcher.js';
import { findFreePort } from '../lib/server-client.js';
import { readWorkspaceEditorState } from '../../server/dist/routes/workspace-state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(__dirname, '..', '..', 'server', 'dist', 'index.js');

/**
 * The model to render first. A workspace that has been opened before names it
 * — reopening should land on what the user was last looking at, not on
 * whatever sorts first — and a fresh one falls back to the first model
 * (part or assembly) at the top level. The page restores the rest of the tab
 * strip itself.
 */
function pickOpeningFile(workspacePath) {
  const { activeTab } = readWorkspaceEditorState(workspacePath);
  if (activeTab) {
    const absPath = isAbsolute(activeTab) ? activeTab : join(workspacePath, activeTab);
    if (existsSync(absPath) && isFluidScriptFile(absPath)) {
      return absPath;
    }
  }
  return findFluidFiles(workspacePath)[0] ?? null;
}

async function runServe(opts) {
  const workspacePath = resolve(opts.workspace);
  const requestedPort = Number(opts.port);
  if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535) {
    throw new Error(`Invalid --port "${opts.port}".`);
  }

  // Another workspace's server (or an editor extension) is often already on
  // 3100; step aside instead of dying on EADDRINUSE.
  const freePort = await findFreePort(requestedPort);
  if (freePort !== requestedPort) {
    console.log(`Port ${requestedPort} is in use — starting on ${freePort} instead.`);
  }
  const port = String(freePort);

  const server = fork(serverEntry, [], {
    env: {
      ...process.env,
      FLUIDCAD_SERVER_PORT: port,
      FLUIDCAD_WORKSPACE_PATH: workspacePath,
    },
    // Load-bearing: without it the engine's sourceLocations shift by the SSR
    // transform's line offset, mis-targeting breakpoints and feature edits.
    execArgv: ['--enable-source-maps'],
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });

  server.stdout.on('data', (data) => { process.stdout.write(data); });
  server.stderr.on('data', (data) => { process.stderr.write(data); });

  let watcher;

  server.on('message', (msg) => {
    if (msg.type === 'ready') {
      console.log(`FluidCAD ready at ${msg.url}`);
      if (opts.open) {
        open(msg.url).catch((err) => {
          console.error(`Failed to open browser: ${err.message}`);
        });
      }
    }
    if (msg.type === 'init-complete') {
      if (msg.success) {
        console.log('FluidCAD initialized successfully.');
        watcher = createFileWatcher(workspacePath, server);

        const opening = pickOpeningFile(workspacePath);
        if (opening) {
          server.send({ type: 'process-file', filePath: opening });
        }
      } else {
        console.error(`FluidCAD initialization failed: ${msg.error}`);
        process.exit(1);
      }
    }
  });

  server.on('exit', (code) => {
    if (watcher) { watcher.close(); }
    process.exit(code || 0);
  });

  process.on('SIGINT', () => {
    if (watcher) { watcher.close(); }
    server.kill('SIGINT');
  });

  process.on('SIGTERM', () => {
    if (watcher) { watcher.close(); }
    server.kill('SIGTERM');
  });
}

export function registerServeCommand(program) {
  program
    .command('serve')
    .description('Open FluidCAD in the browser: 3D viewport, code editor, and live rebuild')
    .option('-w, --workspace <path>', 'workspace directory', process.cwd())
    .option('-p, --port <port>', 'server port (the first free port at or above it is used)', '3100')
    // The page is the whole product now — a viewport, a code editor and the
    // engine — so opening it is the point of the command rather than an extra.
    // `--open` is kept as a no-op flag so existing scripts don't break.
    .option('--open', 'open the UI in the default browser when ready', true)
    .option('--no-open', 'do not open a browser — useful for CI and remote sessions')
    .action((opts) => {
      runServe(opts).catch((err) => {
        console.error(err?.message ?? err);
        process.exit(1);
      });
    });
}
