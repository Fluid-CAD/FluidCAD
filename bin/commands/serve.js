import { fork } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import open from 'open';
import { createFileWatcher, findFluidFiles } from '../watcher.js';
import { findFreePort } from '../lib/server-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(__dirname, '..', '..', 'server', 'dist', 'index.js');

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
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });

  server.stdout.on('data', (data) => { process.stdout.write(data); });
  server.stderr.on('data', (data) => { process.stderr.write(data); });

  let watcher;

  server.on('message', (msg) => {
    if (msg.type === 'ready') {
      console.log(`FluidCAD server ready at ${msg.url}`);
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

        const files = findFluidFiles(workspacePath);
        if (files.length > 0) {
          server.send({ type: 'process-file', filePath: files[0] });
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
    .description('Start the FluidCAD server and watch .fluid.js files')
    .option('-w, --workspace <path>', 'workspace directory', process.cwd())
    .option('-p, --port <port>', 'server port (the first free port at or above it is used)', '3100')
    .option('--open', 'open the UI in the default browser when ready', false)
    .action((opts) => {
      runServe(opts).catch((err) => {
        console.error(err?.message ?? err);
        process.exit(1);
      });
    });
}
